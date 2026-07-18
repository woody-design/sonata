import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright-core";
import { sendPrompt, selectSidebarSession, waitForEngagement } from "./helpers/session.mjs";

// Mid-session CODEX model/effort switch, end-to-end through the FULL app (S4).
// Drives a REAL codex 0.144.5 session and switches its model + reasoning via the
// composer's now-interactive MODEL chip, using the `/model` two-level picker
// choreography:
//   (e) while the cold-start turn runs, the chip is a designed DISABLED state;
//   (a) at idle it opens the Model + Reasoning menu — the curated codex model list
//       and the v1 reasoning set (low→xhigh), each with the current value marked
//       (no CLI-default caption — removed S6);
//   (b) selecting a REASONING (High → Extra High) drives the picker (open → level 1
//       stays on the current model's (current) row → level 2 navigates to Extra
//       high → confirm); the `• Model changed to <model> xhigh` receipt settles it,
//       and the controller writes task.reasoningEffort (codex's receipt IS the
//       confirmation channel — no statusline/hook mirror) so the chip label follows;
//   (c) selecting a MODEL (5.6 Sol → another curated model) drives BOTH levels and
//       PRESERVES the reasoning (navigated explicitly at level 2 — codex drops the
//       (current) marker after a model change); the chip follows to the new model.
//
// Byte discipline (RED LINE 1): NO chat turn may start — an inline `/model <arg>`
// burns a turn, so a run:started during a switch would prove stray bytes hit the
// composer. This fence asserts zero run:started across the switches.
//
// ISOLATION: the app runs against a TEMP CODEX_HOME (real ~/.codex/auth.json
// copied in for auth), so the switch's global model/effort config.toml write, the
// auto-workspace trust ledger, and everything codex-side land in the temp home —
// the user's real ~/.codex is never touched. The test asserts the real config.toml
// is byte-identical before and after (isolation proof), and restores it as a belt.
const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-codexmodel-e2e-"));
const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-codexmodel-home-"));
const realCodexHome = path.join(os.homedir(), ".codex");
const realConfigPath = path.join(realCodexHome, "config.toml");
const realConfigBefore = readRaw(realConfigPath);

const realAuth = path.join(realCodexHome, "auth.json");
if (!fs.existsSync(realAuth)) {
  throw new Error(`No ~/.codex/auth.json — cannot run a real-codex e2e (auth required).`);
}
fs.copyFileSync(realAuth, path.join(codexHome, "auth.json"));

// The curated model + reasoning the spawn pins, and the target model to switch to
// (the probe confirmed both are offered by this account's picker).
const SPAWN_MODEL = "gpt-5.6-sol";
const SPAWN_MODEL_LABEL = "5.6 Sol";
const TARGET_MODEL_LABEL = "5.6 Luna";
const TARGET_MODEL = "gpt-5.6-luna";

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
    window.__transcriptBlocks = 0;
    window.sonataRuntime.onRuntimeEvent((event) => {
      if (event.type === "control-switch:state") {
        window.__controlSwitchEvents.push(event.payload);
      } else if (event.type === "run:started") {
        window.__runStarts += 1;
      } else if (event.type === "transcript:blocks") {
        // The reopen re-attaches the persisted rollout and DRAINS it — that replay
        // re-emits this source's blocks (reset batch), our signal the drain ran.
        window.__transcriptBlocks += 1;
      }
    });
  });

  // A REAL codex task pinned to the spawn model + high reasoning (no cwd →
  // Sonata auto-workspace, pre-trusted, no directory-trust dialog).
  const created = await page.evaluate(
    async ({ model }) =>
      window.sonataRuntime.createTask({ provider: "codex", model, reasoningEffort: "high" }),
    { model: SPAWN_MODEL },
  );
  const taskId = created.task.id;
  findings.taskId = taskId;
  await selectSidebarSession(page, taskId);

  const modelChip = page.locator("#model-chip");

  // Kick a cold-start turn so we can observe the DISABLED-while-running state.
  await sendPrompt(page, "Reply with just: ok");
  await waitForEngagement(page);

  // (e) DISABLED WHILE RUNNING — interactive-shaped but inert while the turn runs.
  await page.locator("#send-prompt.stop-mode").waitFor({ state: "attached", timeout: 120000 });
  findings.disabledWhileRunning = await modelChip.isDisabled();
  findings.interactiveWhileRunning = await modelChip.evaluate((el) =>
    el.classList.contains("interactive"),
  );
  assert.equal(findings.disabledWhileRunning, true, "the codex model chip is disabled while the turn runs");
  assert.equal(findings.interactiveWhileRunning, true, "…and keeps the interactive (caret) shape");

  await page.locator("#send-prompt:not(.stop-mode)").waitFor({ state: "attached", timeout: 180000 });

  // Reset the run:started counter now — the cold-start turn above is a LEGITIMATE
  // run; the RED LINE fence is that the SWITCHES below burn no turn.
  await page.evaluate(() => {
    window.__runStarts = 0;
  });

  // (a) INTERACTIVE AT IDLE — opens the Model + Reasoning menu.
  await modelChip.waitFor({ state: "visible" });
  assert.equal(await modelChip.isDisabled(), false, "the codex model chip is interactive at idle");
  findings.startingChip = (await modelChip.textContent())?.trim() ?? "";
  assert.ok(
    findings.startingChip.includes(SPAWN_MODEL_LABEL) && /High/i.test(findings.startingChip),
    "the chip starts on the spawn model + reasoning (5.6 Sol High)",
  );

  await modelChip.click();
  const menu = page.locator(".composer-session-menu");
  await menu.waitFor({ state: "visible" });
  findings.modelOptions = await settingOptionLabels(page, "Model");
  assert.ok(
    findings.modelOptions.includes(SPAWN_MODEL_LABEL) && findings.modelOptions.includes(TARGET_MODEL_LABEL),
    "the model section offers the curated codex list (incl. the switch target)",
  );
  assert.ok(
    !findings.modelOptions.includes("Native Default"),
    "Native Default is dropped mid-session (no re-spawn to defer to)",
  );
  findings.reasoningOptions = await settingOptionLabels(page, "Reasoning");
  assert.deepEqual(
    findings.reasoningOptions,
    ["Light", "Medium", "High", "Extra High"],
    "the reasoning section offers the v1 set (low→xhigh); Max/Ultra/Native Default dropped",
  );
  findings.currentModelMarked = await currentMarkedLabel(page, "Model");
  findings.currentReasoningMarked = await currentMarkedLabel(page, "Reasoning");
  assert.equal(findings.currentModelMarked, SPAWN_MODEL_LABEL, "the current model is marked");
  assert.equal(findings.currentReasoningMarked, "High", "the current reasoning is marked");
  // No CLI-default caption (removed S6, field revision 5 — disclosure in docs).
  findings.captionCount = await menu.locator(".task-setting-caption").count();
  assert.equal(findings.captionCount, 0, "the CLI-default caption is gone (S6 removal)");

  // (b) STAGED PAIR SAVE (S7 Part 1). The menu is a staged selector — a Save/Cancel
  //     footer, Save disabled while clean. Stage BOTH a new model (5.6 Sol → 5.6
  //     Luna) AND a new reasoning (High → Extra High); Save applies them in ONE
  //     `/model` two-level picker run (level-1 = staged model, level-2 = staged
  //     effort — S4's preserveEffort is now simply "the staged effort always").
  const footer = menu.locator(".composer-staged-footer");
  await footer.waitFor({ state: "visible" });
  const saveBtn = footer.locator(".composer-staged-action.primary");
  assert.equal(await saveBtn.isDisabled(), true, "Save is disabled while the staged pair == current (clean)");
  await settingSection(page, "Model").locator("button", { hasText: exact(TARGET_MODEL_LABEL) }).click();
  await settingSection(page, "Reasoning").locator("button", { hasText: exact("Extra High") }).click();
  findings.stagedModelMarked = await currentMarkedLabel(page, "Model");
  findings.stagedReasoningMarked = await currentMarkedLabel(page, "Reasoning");
  assert.equal(findings.stagedModelMarked, TARGET_MODEL_LABEL, "the staged model pick is marked selected");
  assert.equal(findings.stagedReasoningMarked, "Extra High", "the staged reasoning pick is marked selected");
  assert.equal(
    await settingSection(page, "Model").locator("button.is-current", { hasText: SPAWN_MODEL_LABEL }).count(),
    1,
    "the live model shows the muted Current badge once a different model is staged",
  );
  assert.equal(await saveBtn.isDisabled(), false, "Save enables once the staged pair differs from current");

  const eventsBeforeSave = await page.evaluate(() => (window.__controlSwitchEvents ?? []).length);
  await saveBtn.click();
  const pairResolve = await waitForControlSwitch(page, ["codex-model"], ["settled", "needs-attention"], 60000, eventsBeforeSave);
  findings.pairResolve = pairResolve;
  assert.equal(pairResolve?.phase, "settled", "the staged (model, effort) pair settled in ONE choreography");
  findings.manifestAfterPair = await waitForManifest(
    projectsDir,
    taskId,
    (t) => t.model === TARGET_MODEL && t.reasoningEffort === "xhigh",
    30000,
  );
  assert.equal(findings.manifestAfterPair?.model, TARGET_MODEL, "task.model followed the picker receipt");
  assert.equal(
    findings.manifestAfterPair?.reasoningEffort,
    "xhigh",
    "task.reasoningEffort followed the picker receipt (both axes applied in one run)",
  );
  await page.waitForFunction(
    () => /5\.6 Luna/i.test(document.querySelector("#model-chip")?.textContent ?? ""),
    { timeout: 15000 },
  );
  findings.chipAfterPair = (await modelChip.textContent())?.trim() ?? "";
  assert.ok(
    findings.chipAfterPair.includes(TARGET_MODEL_LABEL) && /Extra High/i.test(findings.chipAfterPair),
    "the chip followed to 5.6 Luna Extra High (the staged pair)",
  );

  // RED LINE 1: no switch started a chat turn.
  findings.runStarts = await page.evaluate(() => window.__runStarts ?? 0);
  assert.equal(findings.runStarts, 0, "no switch burned a turn — zero run:started across the choreography");

  // (d) RESUME REGRESSION (S6 field bug). The switches above ran NO turn, so the
  //     rollout's LAST turn_context still reflects the cold-start turn (5.6 Sol /
  //     High) — the switched Luna/xhigh live ONLY in the manifest (picker receipts).
  //     On reopen the SAME appended-to rollout is re-attached and DRAINED in full;
  //     a naive reconcile would REPLAY that stale turn_context and revert the mirror
  //     (chip 回到 Sol/High — exactly Woody's field report). The fix keeps the
  //     turn_context reconcile LIVE-only, so a replay drain leaves the switch intact.
  const blocksBeforeResume = await page.evaluate(() => window.__transcriptBlocks ?? 0);
  await page.evaluate((id) => window.sonataRuntime.closeTask({ taskId: id }), taskId);
  await page.evaluate((id) => window.sonataRuntime.openTask({ taskId: id, resume: true }), taskId);
  await selectSidebarSession(page, taskId);
  // Wait for the reopened session to re-attach + DRAIN the SAME rollout — the drain
  // re-emits this source's blocks (the replay that, unfixed, reconciles the stale
  // turn_context and reverts the mirror).
  await page.waitForFunction(
    (before) => (window.__transcriptBlocks ?? 0) > before,
    blocksBeforeResume,
    { timeout: 120000 },
  );
  // Settle beat: a (buggy) reconcile persists the manifest synchronously on the
  // drain, so once located has fired the clobber — if any — has already landed.
  await page.waitForTimeout(2500);
  findings.manifestAfterResume = readManifest(projectsDir, taskId);
  assert.equal(
    findings.manifestAfterResume?.model,
    TARGET_MODEL,
    "the switched model SURVIVES a reopen — a replay drain must NOT reconcile the stale turn_context (S6 chip-reverts-on-reopen bug)",
  );
  assert.equal(
    findings.manifestAfterResume?.reasoningEffort,
    "xhigh",
    "the switched reasoning SURVIVES a reopen (same replay-drain guard)",
  );
  await page.waitForFunction(
    () => /5\.6 Luna/i.test(document.querySelector("#model-chip")?.textContent ?? ""),
    { timeout: 15000 },
  );
  findings.chipAfterResume = (await modelChip.textContent())?.trim() ?? "";
  assert.ok(
    findings.chipAfterResume.includes(TARGET_MODEL_LABEL) && /Extra High/i.test(findings.chipAfterResume),
    "the chip still shows 5.6 Luna / Extra High after reopen (no revert)",
  );

  findings.success = true;
  console.log(JSON.stringify({ workspaceRoot, findings, success: true }, null, 2));
  process.exitCode = 0;
} catch (error) {
  console.error(
    JSON.stringify(
      { error: error instanceof Error ? error.message : String(error), findings },
      null,
      2,
    ),
  );
  throw error;
} finally {
  if (electronApp) {
    await electronApp.close();
  }
  const realConfigAfter = readRaw(realConfigPath);
  const realConfigUntouched = realConfigAfter === realConfigBefore;
  console.log(JSON.stringify({ isolation: { realConfigUntouched } }, null, 2));
  if (!realConfigUntouched && realConfigBefore != null) {
    fs.writeFileSync(realConfigPath, realConfigBefore);
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

async function currentMarkedLabel(page, section) {
  return settingSection(page, section)
    .locator("button.selected")
    .first()
    .evaluate((el) => el.childNodes.item(0)?.textContent?.trim() ?? "")
    .catch(() => "");
}

async function waitForControlSwitch(page, kinds, phases, timeoutMs, sinceIndex = 0) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hit = await page.evaluate(
      ({ kinds, phases, sinceIndex }) =>
        (window.__controlSwitchEvents ?? [])
          .slice(sinceIndex)
          .filter((e) => kinds.includes(e.kind) && phases.includes(e.phase))
          .slice(-1)[0] ?? null,
      { kinds, phases, sinceIndex },
    );
    if (hit) {
      return hit;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return null;
}

function readManifest(projectsDir, taskId) {
  try {
    return JSON.parse(fs.readFileSync(path.join(projectsDir, taskId, "task.json"), "utf8"))?.task ?? null;
  } catch {
    return null;
  }
}

async function waitForManifest(projectsDir, taskId, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = readManifest(projectsDir, taskId);
    if (last && predicate(last)) {
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
