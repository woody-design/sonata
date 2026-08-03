// Mid-session CODEX model/effort switch — REAL-CLI choreography (S4).
//
// Drives a REAL codex 0.144.5 through the actual TerminalHost and exercises the
// `/model` TWO-level picker choreography end-to-end:
//   1. open   — type bare `/model` (+ Enter) → the level-1 (model) picker renders;
//   2. level 1 — arrow the `›` cursor to the target model ROW (matched by TEXT),
//      one press at a time, re-reading the cursor after each; Enter opens level 2;
//   3. level 2 — arrow to the reasoning ROW (matched by TEXT), Enter confirms;
//   4. receipt — the `• Model changed to <model> <effort>` line → a `settled`
//      control-switch:state carrying the receipt's (model, effort) pair.
//
// The picker FORCES a (model, effort) pair; each switch preserves the non-selected
// dimension — but by DIFFERENT means per direction (MEASURED, not the plan's first
// read; see B):
//   A. effort   high → xhigh   (level 1 stays on the current model's `(current)`
//               row — the model is unchanged, so that marker IS reliable; level 2
//               navigates to Extra high)                 → settled, effort=xhigh
//   B. model    sol → luna → sol  (level 1 navigates to the new model; level 2
//               navigates to the current effort EXPLICITLY — `from`=xhigh — NOT via
//               a `(current)` marker)                     → settled, effort preserved
//      — MEASURED: after choosing a DIFFERENT model, codex RESETS the reasoning to
//        that model's default and marks NO level-2 `(current)` row. So an effort can
//        only be preserved across a model change by navigating to its explicit value
//        (task.reasoningEffort, threaded as `from`). This case proves that explicit
//        path holds xhigh across sol→luna→sol; without `from` the switch would roll
//        back (verified during bring-up).
//   C. mismatch — a target row the picker doesn't offer rolls back with the
//      LEVEL-APPROPRIATE Esc(es) + needs-attention (never a blind retry):
//        C1 level-1 miss (a model absent from the picker — D5): 1 Esc.
//        C2 level-2 miss (a test seam forces it after level 1 confirmed): Esc×2
//           (level 2 → level 1 → composer).
//   D. residual composer text (F1): a human types unsubmitted text, THEN a switch
//      is driven — the unconditional pre-command clear wipes it so `/model` opens
//      cleanly and no chat turn is burned.
//
// Byte discipline (RED LINE 1): across ALL switches, NO chat turn may start — an
// inline `/model <arg>` submits as a prompt and burns a turn, so a `run:started`
// during a switch would prove stray bytes hit the composer. This fence asserts
// zero run:started.
//
// Config hygiene (mandatory): snapshots ~/.codex/config.toml before the run,
// restores + DIFFS it after (a confirm persists `model`/`model_reasoning_effort`
// globally). The throwaway smoke trust profile is a SEPARATE file, removed at
// teardown — it never touches config.toml.
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  TerminalHost,
  cleanTerminal,
  codexArgs,
  codexModelPickerLevel1Open,
  codexModelPickerFooterVisible,
} = require("../../dist/runtime");
const {
  CODEX_SMOKE_PROFILE,
  ensureSmokeTrustProfile,
  removeSmokeTrustProfile,
  isCodexUpdatePrompt,
  CODEX_UPDATE_PROMPT_SKIP_REASON,
  SmokeSkip,
} = await import("./codex-smoke-trust.mjs");

const taskId = "task-codex-model-smoke";
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-codex-model-"));
const codexHome = process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
const configPath = path.join(codexHome, "config.toml");
const configBefore = fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf8") : null;

const SPAWN_MODEL = "gpt-5.6-sol";
const OTHER_MODEL = "gpt-5.6-luna"; // a non-current model the probe confirmed present
// C1's rollback target — SYNTHETIC ON PURPOSE (upstream watch-item W5: the codex
// model catalog is SERVER-mutable, so the picker's row set can change with no CLI
// release). C1 proves seek-exhaustion → clean rollback, so its target must be one
// no catalog can ever serve. It used to be the legacy `gpt-5.4`, chosen because
// legacy models were reachable only via `codex -m`; the server began offering that
// row again (measured 2026-08-03, codex 0.146.0) and the switch SETTLED — the case
// went red on its premise, not on a defect. The slug keeps the lowercase `gpt-…`
// shape the level-1 row parser reads, so this still exercises "target row ABSENT
// from a well-parsed picker", not "malformed target string".
const ABSENT_MODEL = "gpt-0.0-sonata-smoke-never-served";

let rawTail = "";
let ptyExited = false;
let runStarts = 0;
const switchEvents = [];

const host = new TerminalHost({
  taskId,
  defaultWorkspace: workspace,
  eventSink: (event) => {
    if (event.type === "pty:data") {
      rawTail = `${rawTail}${event.payload.data}`.slice(-96 * 1024);
      return;
    }
    if (event.type === "control-switch:state") {
      switchEvents.push(event.payload);
    } else if (event.type === "run:started") {
      runStarts += 1; // RED LINE 1 tripwire: a switch must NEVER burn a turn.
    } else if (event.type === "pty:exit") {
      ptyExited = true;
    }
  },
});

const findings = {};

try {
  ensureSmokeTrustProfile(workspace);
  host.startTask({
    cwd: workspace,
    args: codexArgs({
      cwd: workspace,
      permissionMode: "ask-for-approval",
      model: SPAWN_MODEL,
      reasoningEffort: "high",
      profile: CODEX_SMOKE_PROFILE,
    }),
    rows: 36,
    cols: 120,
  });

  await waitUntil(() => host.acceptsPromptInput() || ptyExited, 60000);
  if (ptyExited || !host.acceptsPromptInput()) {
    const tail = redactedTail();
    // ONLY codex's boot update gate skips; every other readiness failure FAILs.
    if (isCodexUpdatePrompt(tail)) {
      throw new SmokeSkip(CODEX_UPDATE_PROMPT_SKIP_REASON);
    }
    if (ptyExited) {
      throw new Error(`codex PTY exited before readiness.\n${tail}`);
    }
    throw new Error(`codex composer never reached readiness.\n${tail}`);
  }
  await delay(1500); // settle — the composer + model line paint before we switch

  // A — effort switch high → xhigh (model preserved via level-1 `(current)`).
  findings.switchA = await drive("codex-effort", "xhigh");

  // B — model switch sol → luna → sol; the current effort (xhigh) is preserved at
  // level 2 EXPLICITLY (`from`) — codex drops the level-2 `(current)` marker after
  // a model change, so it can't ride that marker (measured).
  findings.switchB1 = await drive("codex-model", OTHER_MODEL, { from: "xhigh" });
  findings.switchB2 = await drive("codex-model", SPAWN_MODEL, { from: "xhigh" });

  // C1 — level-1 mismatch: a model the picker cannot list (D5) → 1-Esc rollback.
  findings.switchC1 = await drive("codex-model", ABSENT_MODEL, { from: "xhigh" });

  // C2 — level-2 mismatch via the test seam (forces a miss AFTER level 1) → Esc×2.
  process.env.SONATA_TEST_CODEX_MODEL_MISMATCH = "l2";
  findings.switchC2 = await drive("codex-effort", "medium");
  delete process.env.SONATA_TEST_CODEX_MODEL_MISMATCH;

  // D — residual composer text: the unconditional clear wipes it, switch settles,
  // no turn burned.
  const runsBeforeResidual = runStarts;
  findings.switchD = await drive("codex-effort", "high", { residualText: "let me think ZZRESIDUALZZ" });
  findings.residualBurnedTurn = runStarts > runsBeforeResidual;
  findings.runStarts = runStarts;

  // A — effort switch settled, receipt carried the preserved model + new effort.
  assert.equal(findings.switchA.phase, "settled", "A: high→xhigh settled");
  assert.equal(findings.switchA.codexEffort, "xhigh", "A: receipt effort = xhigh");
  assert.equal(findings.switchA.codexModel, SPAWN_MODEL, "A: model preserved (level-1 (current))");
  assert.equal(findings.switchA.pickerClosed, true, "A: picker closed after confirm");

  // B — model switch preserved xhigh by navigating level 2 to the EXPLICIT current
  //     effort (`from`) — codex drops the level-2 (current) marker after a model
  //     change (measured), so the marker path can't be used here.
  assert.equal(findings.switchB1.phase, "settled", "B1: sol→luna settled");
  assert.equal(findings.switchB1.codexModel, OTHER_MODEL, "B1: model followed to luna");
  assert.equal(
    findings.switchB1.codexEffort,
    "xhigh",
    "B1: effort PRESERVED at xhigh via EXPLICIT level-2 navigation after a model change",
  );
  assert.equal(findings.switchB2.phase, "settled", "B2: luna→sol settled");
  assert.equal(findings.switchB2.codexModel, SPAWN_MODEL, "B2: model followed back to sol");
  assert.equal(findings.switchB2.codexEffort, "xhigh", "B2: effort still xhigh");

  // C — mismatch rollbacks: needs-attention, picker(s) closed, mode unchanged.
  assert.equal(findings.switchC1.phase, "needs-attention", "C1: absent model rolls back (D5)");
  assert.equal(findings.switchC1.pickerClosed, true, "C1: the rollback Esc returned to the composer");
  // S5 item C: an absent curated target is upstream model-list drift — the
  // needs-attention event carries reason "drift" so the banner says "switch in the
  // CLI" instead of the generic "couldn't confirm". This is also what keeps C1
  // honest with a synthetic target: "drift" is set at exactly ONE site — the
  // level-capture target miss, reached only from a COMPLETE picker frame (footer
  // visible, cursor readable) whose captured row order lacks the target. A picker
  // that never opened, or a rollback from an unexpected cursor jump, carries no
  // reason at all. So this assertion still proves seek-exhaustion → clean rollback.
  assert.equal(findings.switchC1.reason, "drift", "C1: absent-model rollback is reasoned as drift");
  assert.equal(findings.switchC2.phase, "needs-attention", "C2: level-2 miss rolls back");
  assert.equal(findings.switchC2.pickerClosed, true, "C2: the Esc×2 rollback returned to the composer");
  assert.equal(findings.switchC2.reason, "drift", "C2: level-2 miss (no v1 row) is reasoned as drift");

  // D — residual text switch still settled AND burned no turn.
  assert.equal(findings.switchD.phase, "settled", "D: switch with residual composer text still settled");
  assert.equal(findings.switchD.codexEffort, "high", "D: effort switched to high despite residual text");
  assert.equal(findings.residualBurnedTurn, false, "D: residual text did NOT burn a turn (RED LINE 1)");

  // Byte discipline (RED LINE 1): no switch started a chat turn.
  assert.equal(runStarts, 0, "no switch burned a turn — zero run:started across the choreography");

  findings.success = true;
  console.log(
    JSON.stringify({ provider: "codex", transport: "node-pty", workspace, ...findings }, null, 2),
  );
  process.exitCode = 0;
} catch (error) {
  delete process.env.SONATA_TEST_CODEX_MODEL_MISMATCH;
  if (error instanceof SmokeSkip) {
    console.log(`SKIP: ${error.message}`);
    process.exitCode = 77;
  } else {
    console.error(
      JSON.stringify(
        { error: error instanceof Error ? error.message : String(error), findings, tail: redactedTail() },
        null,
        2,
      ),
    );
    process.exitCode = 1;
  }
} finally {
  host.dispose();
  removeSmokeTrustProfile();
  fs.rmSync(workspace, { recursive: true, force: true });
  if (configBefore != null) {
    const after = fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf8") : null;
    const changed = after !== configBefore;
    fs.writeFileSync(configPath, configBefore, "utf8");
    const restored = fs.readFileSync(configPath, "utf8") === configBefore;
    console.log(JSON.stringify({ configHygiene: { changedByRun: changed, restored } }, null, 2));
  }
}

/** Drive one switch and collect its evidence. `residualText` (optional) is typed
 *  into the composer as a co-present human would — no Enter — BEFORE the switch,
 *  to exercise the unconditional pre-command clear (F1). */
async function drive(kind, value, { residualText, from } = {}) {
  const before = switchEvents.length;
  if (residualText) {
    host.writeUserInput(residualText); // human typing into the idle Terminal (no dirty flag)
    await delay(600);
  }
  rawTail = "";
  // `from` = the effort to preserve for a codex-model switch (the renderer supplies
  // task.reasoningEffort; codex drops the level-2 (current) marker after a model change).
  const res = host.injectClaudeControlSwitch(kind, value, from);
  assert.equal(res.ok, true, `switch ${kind}:${value} accepted`);

  await waitUntil(() => codexModelPickerLevel1Open(rawTail) || resolved(before), 15000);
  const pickerOpened = codexModelPickerLevel1Open(rawTail) || resolved(before);
  await waitUntil(() => resolved(before), 25000);
  const evts = switchEvents.slice(before);
  const terminal = evts.find((e) => e.phase === "settled" || e.phase === "needs-attention");

  // "Picker closed" = a FRESH tail shows no picker footer — the composer is back.
  rawTail = "";
  await delay(1200);
  const pickerClosed = !codexModelPickerFooterVisible(rawTail);

  return {
    kind,
    value,
    pickerOpened,
    pending: evts.some((e) => e.phase === "pending"),
    phase: terminal?.phase ?? null,
    reason: terminal?.reason ?? null,
    codexModel: terminal?.codexModel ?? null,
    codexEffort: terminal?.codexEffort ?? null,
    pickerClosed,
  };
}

function resolved(sinceIndex) {
  return switchEvents
    .slice(sinceIndex)
    .some((e) => e.phase === "settled" || e.phase === "needs-attention" || e.phase === "failed");
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return true;
    }
    await delay(200);
  }
  return false;
}

function redactedTail() {
  return cleanTerminal(rawTail).replaceAll(os.homedir(), "~").slice(-2500);
}
