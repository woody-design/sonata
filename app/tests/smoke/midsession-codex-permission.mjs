// Mid-session CODEX permission switch — REAL-CLI choreography (S3).
//
// Drives a REAL codex 0.144.5 through the actual TerminalHost and exercises the
// `/permissions` picker choreography end-to-end:
//   1. open  — type bare `/permissions` (+ Enter) → the picker header renders;
//   2. navigate — arrow the `›` cursor to the target ROW (matched by TEXT), one
//      press at a time, re-reading the cursor after each;
//   3. confirm — Enter on the target row → the `• Permissions updated to <label>`
//      receipt → a `settled` control-switch:state event.
//
// Three switches, covering the happy path (down + up nav) AND the RED LINE
// consent-gate rollback:
//   A. ask-for-approval → approve-for-me   (down ×1)  → settled + receipt
//   B. approve-for-me   → ask-for-approval (up ×1)    → settled + receipt
//   C. ask-for-approval → full-access      (down ×2)  → needs-attention
//      Confirming Full Access opens a "Enable full access?" CONSENT dialog, not
//      a receipt (measured). RED LINE 2: Sonata must NEVER auto-answer that
//      consent — the engine recognizes it, rolls back with a single Esc (returns
//      to the composer — measured), and surfaces needs-attention. The session
//      stays on its previous mode; Full Access is the human's to grant in the CLI.
//
// Byte discipline (RED LINE 1): across ALL switches, NO chat turn may start — an
// unrecognized codex slash line submits as a prompt and burns a turn, so a
// `run:started` during a switch would prove stray bytes hit the composer. This
// fence asserts zero run:started.
//
// Config hygiene (mandatory): snapshots ~/.codex/config.toml before the run,
// restores + DIFFS it after (a confirm can persist `approvals_reviewer`
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
  codexPermissionPickerOpen,
  codexPermissionPickerFooterVisible,
  parseCodexPermissionReceipt,
} = require("../../dist/runtime");
const {
  CODEX_SMOKE_PROFILE,
  ensureSmokeTrustProfile,
  removeSmokeTrustProfile,
} = await import("./codex-smoke-trust.mjs");

const taskId = "task-codex-perm-smoke";
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-codex-perm-"));
const codexHome = process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
const configPath = path.join(codexHome, "config.toml");
const configBefore = fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf8") : null;

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
      profile: CODEX_SMOKE_PROFILE,
    }),
    rows: 36,
    cols: 120,
  });

  await waitUntil(() => host.acceptsPromptInput() || ptyExited, 60000);
  if (ptyExited) {
    throw new Error(`codex PTY exited before readiness.\n${redactedTail()}`);
  }
  if (!host.acceptsPromptInput()) {
    throw new Error(`codex composer never reached readiness.\n${redactedTail()}`);
  }
  await delay(1200); // one settle tick — the composer paints before the model line fills

  findings.switchA = await drive("ask-for-approval", "approve-for-me");
  findings.switchB = await drive("approve-for-me", "ask-for-approval");
  findings.switchC = await drive("ask-for-approval", "full-access");

  // (F1 regression) RESIDUAL TEXT: a human types unsubmitted text straight into
  // the idle Terminal composer (no dirty flag), THEN a switch is driven. The
  // unconditional pre-command clear must wipe it so `/permissions` opens the
  // picker cleanly — WITHOUT the clear, `<residual>/permissions` submits as a
  // chat prompt (RED LINE 1: codex burns a turn and the run cancels the switch).
  const runsBeforeResidual = runStarts;
  findings.switchD = await drive("ask-for-approval", "approve-for-me", {
    residualText: "let me think ZZRESIDUALZZ",
  });
  findings.residualBurnedTurn = runStarts > runsBeforeResidual;
  findings.runStarts = runStarts;

  // A + B — happy path: settled, receipt matched, picker closed.
  assert.equal(findings.switchA.phase, "settled", "A: ask→approve settled");
  assert.equal(findings.switchA.receipt, "approve-for-me", "A: receipt = approve-for-me");
  assert.equal(findings.switchA.pickerClosed, true, "A: picker closed after confirm");
  assert.equal(findings.switchB.phase, "settled", "B: approve→ask settled (up-nav)");
  assert.equal(findings.switchB.receipt, "ask-for-approval", "B: receipt = ask-for-approval");
  assert.equal(findings.switchB.pickerClosed, true, "B: picker closed after confirm");

  // C — Full Access consent gate: NEVER auto-answered → needs-attention + rollback.
  assert.equal(
    findings.switchC.phase,
    "needs-attention",
    "C: Full Access consent dialog is not auto-answered — the switch rolls back to needs-attention",
  );
  assert.equal(
    findings.switchC.pickerClosed,
    true,
    "C: the rollback Esc returned to the composer (consent dialog + picker both closed)",
  );

  // (F1) The residual-text switch still settled AND burned no turn — the
  // unconditional clear wiped the human's untracked typing before `/permissions`.
  assert.equal(findings.switchD.phase, "settled", "D: switch with residual composer text still settled");
  assert.equal(findings.switchD.receipt, "approve-for-me", "D: receipt matched despite residual text");
  assert.equal(findings.residualBurnedTurn, false, "D: residual text did NOT concatenate into a burned turn (RED LINE 1)");

  // Byte discipline (RED LINE 1): no switch started a chat turn.
  assert.equal(runStarts, 0, "no switch burned a turn — zero run:started across the choreography");

  findings.success = true;
  console.log(
    JSON.stringify({ provider: "codex", transport: "node-pty", workspace, ...findings }, null, 2),
  );
  process.exitCode = 0;
} catch (error) {
  console.error(
    JSON.stringify(
      { error: error instanceof Error ? error.message : String(error), findings, tail: redactedTail() },
      null,
      2,
    ),
  );
  process.exitCode = 1;
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
async function drive(from, target, { residualText } = {}) {
  const before = switchEvents.length;
  if (residualText) {
    host.writeUserInput(residualText); // human typing into the idle Terminal (no dirty flag)
    await delay(600); // let it render on the composer line before we switch
  }
  rawTail = "";
  const res = host.injectClaudeControlSwitch("codex-permission", target, from);
  assert.equal(res.ok, true, `switch ${from}→${target} accepted`);

  await waitUntil(() => codexPermissionPickerOpen(rawTail) || resolved(before), 15000);
  const pickerOpened = codexPermissionPickerOpen(rawTail) || resolved(before);
  await waitUntil(() => resolved(before), 20000);
  const evts = switchEvents.slice(before);
  const terminal = evts.find((e) => e.phase === "settled" || e.phase === "needs-attention");
  const receipt = parseCodexPermissionReceipt(rawTail);

  // "Picker closed" = a FRESH tail (post-resolution) shows no picker footer — the
  // composer is back. Reset + settle so a stale footer frame from earlier in the
  // accumulated tail can't mask the close.
  rawTail = "";
  await delay(1000);
  const pickerClosed = !codexPermissionPickerFooterVisible(rawTail);

  return {
    from,
    target,
    pickerOpened,
    pending: evts.some((e) => e.phase === "pending"),
    phase: terminal?.phase ?? null,
    receipt,
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
  return cleanTerminal(rawTail).replaceAll(os.homedir(), "~").slice(-2000);
}
