import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright-core";
import {
  chooseDraftProvider,
  sendFirstPrompt,
  sendPrompt,
  waitForEngagement,
} from "./helpers/session.mjs";

// Mid-session PERMISSION switch, end-to-end (S2). Drives a REAL Claude session
// and switches its permission mode via the composer's now-interactive ACCESS
// chip, using the native Shift+Tab (`\x1b[Z`) stepping engine:
//   (d) while the cold-start turn runs, the chip is a designed DISABLED state;
//   (2) at idle it opens the Approvals menu — default/acceptEdits/plan/AUTO are
//       always offered (D4 field revision 2026-07-18: auto is no longer
//       observed-gated, so it is reachable from a Manual-spawned session); bypass
//       stays absent (spawn-only). Current mode marked;
//   (a) selecting Auto steps default → accept edits → plan → auto; the settled
//       event's `observedModes` lists every mode a step's mode-line receipt
//       confirmed (the proof each step was READ, incl. the plan pass-through);
//   (b/c) after a trivial prompt, the hook payload's permission_mode reconciles
//       the task to `auto` (SSOT) and the chip label follows to "Auto" —
//       Manual→Auto works LIVE, which is the point of the D4 revision;
//   (e) a NATIVE terminal Shift+Tab (injected outside the engine) still mirrors
//       correctly FROM auto — the pre-existing display path didn't regress.
//
// Shift+Tab is SESSION-SCOPED — it must NOT persist to ~/.claude.json /
// settings.json (unlike `/model` / `/effort`). This test snapshots settings.json
// and asserts the permission choreography left it untouched, restoring in
// `finally` as a belt.
const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-midperm-e2e-"));
const evidenceDir = process.env.SONATA_MIDSESSION_EVIDENCE
  ? fs.mkdtempSync(path.join(os.tmpdir(), "sonata-midperm-evidence-"))
  : null;
const claudeSettingsPath = path.join(os.homedir(), ".claude", "settings.json");
const settingsBefore = readSettingsRaw();

let electronApp = null;
let page = null;
const findings = {};

try {
  electronApp = await electron.launch({
    args: ["dist/main/main.js"],
    env: {
      ...process.env,
      SONATA_DATA_DIR: workspaceRoot,
      SONATA_WORKSPACES_DIR: workspaceRoot,
    },
  });

  page = await electronApp.firstWindow();
  page.setDefaultTimeout(240000);
  await page.locator(".task-entry-panel").waitFor({ state: "visible" });
  await chooseDraftProvider(page, "claude");
  const projectsDir = path.join(workspaceRoot, "data", "projects");

  // Capture every control-switch:state event in the page so we can inspect the
  // permission choreography's phases + observedModes directly.
  await page.evaluate(() => {
    window.__controlSwitchEvents = [];
    window.sonataRuntime.onRuntimeEvent((event) => {
      if (event.type === "control-switch:state") {
        window.__controlSwitchEvents.push(event.payload);
      }
    });
  });

  await sendFirstPrompt(page, "Count slowly from 1 to 12, one number per line, then say done.", { provider: "claude" });
  await waitForEngagement(page);

  // (d) DISABLED WHILE RUNNING — the access chip is interactive-shaped (Claude)
  //     but inert while the turn is live (turnActivity SSOT; no queueing).
  await page.locator("#send-prompt.stop-mode").waitFor({ state: "attached" });
  const accessChip = page.locator("#permission-chip");
  const disabledWhileRunning = await accessChip.isDisabled();
  const interactiveWhileRunning = await accessChip.evaluate((el) =>
    el.classList.contains("interactive"),
  );
  assert.equal(disabledWhileRunning, true, "the access chip is disabled while the turn runs");
  assert.equal(
    interactiveWhileRunning,
    true,
    "…and keeps the interactive (caret) shape — a designed disabled state",
  );

  // Wait for idle.
  await page.locator("#send-prompt:not(.stop-mode)").waitFor({ state: "attached", timeout: 180000 });
  const taskId = await waitForTaskId(projectsDir, 30000);

  // (2) INTERACTIVE AT IDLE — enabled, opens the Approvals menu.
  await accessChip.waitFor({ state: "visible" });
  assert.equal(await accessChip.isDisabled(), false, "the access chip is interactive at idle");
  const startingChip = (await accessChip.textContent())?.trim() ?? "";
  findings.startingChip = startingChip;

  await accessChip.click();
  const menu = page.locator(".composer-session-menu");
  await menu.waitFor({ state: "visible" });
  const optionLabels = await settingOptionLabels(page, "Approvals");
  findings.menuOptions = optionLabels;
  // A default-spawned session: default/acceptEdits/plan/AUTO always offered (D4
  // field revision 2026-07-18 — auto is no longer observed-gated, or it would be
  // unreachable forever on a Manual-spawned session). Bypass stays absent (it is
  // spawn-only, and a Sonata launch never offers it — non-dead by construction).
  assert.deepEqual(
    optionLabels,
    ["Manual", "Accept edits", "Plan mode", "Auto"],
    "the menu always offers Auto (D4 revision) and omits the spawn-only bypass on a default-spawned session",
  );
  const currentMarked = (
    await settingSection(page, "Approvals")
      .locator("button.selected")
      .first()
      .evaluate((el) => el.childNodes.item(0)?.textContent?.trim() ?? "")
      .catch(() => "")
  );
  findings.currentMarked = currentMarked;
  assert.equal(currentMarked, "Manual", "the current mode (default → Manual) is marked");

  if (evidenceDir) {
    await page.screenshot({ path: path.join(evidenceDir, "01-access-menu.png") });
  }

  // (a) DRIVE Manual → Auto (the D4-revision leg). The engine steps `\x1b[Z`
  //     default→acceptEdits→plan→auto, reading each mode line as the per-step
  //     receipt. Auto is only reachable because it is now always offered — the
  //     observed-only rule would have hidden it on this Manual-spawned session.
  await settingSection(page, "Approvals").locator("button", { hasText: exact("Auto") }).click();

  // Wait for the permission switch to resolve (settled or needs-attention).
  const resolved = await waitForControlSwitch(page, "permission", ["settled", "needs-attention"], 30000);
  findings.permissionResolve = resolved;
  assert.ok(resolved, "the permission switch emitted a terminal control-switch:state event");
  // observedModes proves each step's mode line was READ (a per-step receipt):
  // stepping default→auto passes THROUGH acceptEdits and plan, then lands on auto.
  assert.ok(
    Array.isArray(resolved.observedModes),
    "the permission event carries the modes its receipts confirmed",
  );
  findings.observedModes = resolved.observedModes;
  assert.ok(
    resolved.observedModes.includes("acceptEdits") &&
      resolved.observedModes.includes("plan") &&
      resolved.observedModes.includes("auto"),
    "observedModes includes the pass-throughs (acceptEdits, plan) and target (auto) — each step's receipt was read",
  );
  assert.equal(resolved.phase, "settled", "the target (auto) was reached and settled — Manual→Auto works live");

  if (evidenceDir) {
    await page.screenshot({ path: path.join(evidenceDir, "02-after-switch-settled.png") });
  }

  // Settings.json must be UNCHANGED by the permission choreography (session-scoped
  // — Shift+Tab never persists a default, unlike /model /effort).
  const settingsAfterSwitch = readSettingsRaw();
  findings.settingsTouchedBySwitch = settingsAfterSwitch !== settingsBefore;
  assert.equal(
    settingsAfterSwitch,
    settingsBefore,
    "the Shift+Tab permission switch did NOT write ~/.claude/settings.json (session-scoped)",
  );

  // (b/c) SSOT RECONCILE — the mode line was receipt-only; task.permissionMode
  //       follows the hook payload on the next turn. Send a trivial prompt.
  await sendPrompt(page, "Reply with just: ok");
  await waitForEngagement(page);
  await page.locator("#send-prompt:not(.stop-mode)").waitFor({ state: "attached", timeout: 180000 });

  const modeAfterAuto = await waitForManifestMode(projectsDir, taskId, "auto", 60000);
  findings.hookModeAfterAuto = modeAfterAuto;
  assert.equal(modeAfterAuto, "auto", "the hook payload reconciled task.permissionMode to auto (SSOT)");
  const chipAfterAuto = (await accessChip.textContent())?.trim() ?? "";
  findings.chipAfterAuto = chipAfterAuto;
  assert.ok(chipAfterAuto.includes("Auto"), "the access chip label followed the hook to Auto");

  if (evidenceDir) {
    await page.screenshot({ path: path.join(evidenceDir, "03-chip-follows-plan.png") });
  }

  // (e) NATIVE Shift+Tab — inject `\x1b[Z` OURSELVES (outside the stepping engine)
  //     and confirm the pre-existing mirror path still tracks the mode. From auto
  //     the cycle advances (to bypass if account-gated on, else back to manual);
  //     whatever it lands in, task.permissionMode must follow the hook.
  await page.evaluate(
    ({ id }) => window.sonataRuntime.writeTerminalUserInput({ taskId: id, data: "\x1b[Z" }),
    { id: taskId },
  );
  await sendPrompt(page, "Reply with just: ok");
  await waitForEngagement(page);
  await page.locator("#send-prompt:not(.stop-mode)").waitFor({ state: "attached", timeout: 180000 });
  const modeAfterNative = await waitForManifestModeChange(projectsDir, taskId, "auto", 60000);
  findings.hookModeAfterNativeShiftTab = modeAfterNative;
  assert.notEqual(
    modeAfterNative,
    "auto",
    "a native Shift+Tab advanced the mode off auto (the pre-existing mirror path did not regress)",
  );
  const chipAfterNative = (await accessChip.textContent())?.trim() ?? "";
  findings.chipAfterNative = chipAfterNative;

  if (evidenceDir) {
    await page.screenshot({ path: path.join(evidenceDir, "04-after-native-shifttab.png") });
  }

  console.log(JSON.stringify({ workspaceRoot, evidenceDir, taskId, findings, success: true }, null, 2));
  process.exitCode = 0;
} catch (error) {
  console.error(
    JSON.stringify(
      {
        error: error instanceof Error ? error.message : String(error),
        workspaceRoot,
        findings,
        runtimeStatus: page ? await safeText(page.locator("#runtime-status")) : null,
        chipText: page ? await safeText(page.locator("#permission-chip")) : null,
        controlEvents: page
          ? await page.evaluate(() => window.__controlSwitchEvents ?? null).catch(() => null)
          : null,
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
  restoreSettingsRaw(settingsBefore);
  fs.rmSync(workspaceRoot, { recursive: true, force: true });
}

/** Exact-match RegExp for Playwright hasText. */
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
    .evaluateAll((buttons) => buttons.map((button) => button.childNodes.item(0)?.textContent?.trim() ?? ""));
}

/** Await a control-switch:state event of the given kind in one of `phases`. */
async function waitForControlSwitch(page, kind, phases, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hit = await page.evaluate(
      ({ kind, phases }) =>
        (window.__controlSwitchEvents ?? [])
          .filter((e) => e.kind === kind && phases.includes(e.phase))
          .slice(-1)[0] ?? null,
      { kind, phases },
    );
    if (hit) {
      return hit;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return null;
}

async function waitForTaskId(projectsDir, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let entry = null;
    try {
      entry = fs
        .readdirSync(projectsDir, { withFileTypes: true })
        .find((item) => item.isDirectory())?.name;
    } catch {
      entry = null;
    }
    if (entry) {
      return entry;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Timed out waiting for the session's task directory.");
}

function readManifestMode(projectsDir, taskId) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(projectsDir, taskId, "task.json"), "utf8"));
    return parsed?.task?.permissionMode ?? null;
  } catch {
    return null;
  }
}

async function waitForManifestMode(projectsDir, taskId, expected, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = readManifestMode(projectsDir, taskId);
    if (last === expected) {
      return last;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return last;
}

async function waitForManifestModeChange(projectsDir, taskId, from, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = readManifestMode(projectsDir, taskId);
  while (Date.now() < deadline) {
    last = readManifestMode(projectsDir, taskId);
    if (last && last !== from) {
      return last;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return last;
}

async function safeText(locator) {
  try {
    return await locator.textContent({ timeout: 1000 });
  } catch {
    return null;
  }
}

function readSettingsRaw() {
  try {
    return fs.readFileSync(claudeSettingsPath, "utf8");
  } catch {
    return null;
  }
}

function restoreSettingsRaw(raw) {
  if (raw == null) {
    return;
  }
  try {
    fs.writeFileSync(claudeSettingsPath, raw);
  } catch {
    // Best-effort restore.
  }
}
