#!/usr/bin/env node
// q35 — Read Only: what channel can carry the fourth codex permission mode, and
// does Sonata's DRIVE still work from inside it (SL-17).
//
// SL-7/D6 measured that codex 0.152.1 has a FOURTH permission mode — `Read Only`
// — reachable only through the #39873 cycle (`tui.keymap.chat.next_permission_mode`,
// which ships with NO default binding). It measured two things about the exposure
// and left the third unmeasured:
//
//   MEASURED (D6): the receipt line prints `• Permissions updated to Read Only`,
//   and while the CLI sits in Read Only the `/permissions` picker still paints its
//   three rows with NO `(current)` marker and a readable `›` cursor on row 1.
//
//   UNMEASURED: what a Read Only turn writes into the rollout's `turn_context` —
//   which is the ONLY channel Sonata reads for a NATIVE codex mid-session switch
//   (`reconcileCodexTurnContext`; the picker receipt is read ONLY inside a
//   Sonata-initiated switch window, so it cannot see a native cycle at all).
//   SL-8/r4's corpus has `(read-only, never)` ×186 and `(read-only, on-request)`
//   ×61, but EVERY one of those records is 0.142.x–0.146.0 — they predate #39873
//   and say nothing about what the Read Only PRESET projects at 0.152.1.
//
//   UNMEASURED: that the picker WALK actually lands from a no-`(current)` picker.
//   D6 measured that the cursor PARSES; parsing a row is not the same claim as
//   the choreography reaching a target row and settling on its receipt.
//
// SOURCE FACT (openai/codex, rust-v0.152.0,
// `codex-rs/tui/src/chatwidget/permission_shortcuts.rs`): the cycle enumerates
// `builtin_approval_presets()` filtered to the `read-only` and `auto` presets ×
// reviewer, and the display label comes from a match on (preset.id, reviewer):
// `("auto", User)` → "Ask for approval", `("auto", AutoReview)` → "Approve for
// me", everything else → `preset.label` (= "Read Only"). So the two modes Sonata
// CAN name both ride the `auto` preset, and "Read Only" is the `read-only`
// preset. That is a SOURCE claim about which preset each label rides; it is not
// a measurement of what the preset writes into a rollout. This probe measures.
//
// ARMS
//   A  read-only-projection — one live session: a control turn spawned
//      ask-for-approval, then the cycle into Read Only, then a second turn.
//      Both `turn_context` records are read off the rollout and fed through the
//      PRODUCTION `codexPermissionModeFromTurnContext`, so the capture shows what
//      Sonata's own reconcile does with them at the build in `dist/`.
//   B  drive-from-read-only — with the CLI STILL in Read Only, the production
//      `TerminalHost.injectClaudeControlSwitch("codex-permission", …)` drives a
//      real switch and the probe watches for a `settled` phase. Then a third turn
//      re-reads `turn_context` to confirm the CLI actually moved (the receipt
//      says it did; the rollout is the independent witness).
//
// ISOLATION + SETTINGS GUARD (F41). Everything runs against an isolated
// CODEX_HOME under /private/tmp with only `auth.json` seeded. The real
// `~/.codex/config.toml` and `~/.codex/sonata.config.toml` are byte-snapshotted
// at start and byte-verified at end; a drift is reported as a FAILURE in the
// capture, not swallowed.
//
// Usage: node q35-read-only-mode.mjs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { createRequire } from "node:module";

import {
  CodexBoot,
  EXPECT_CODEX_VERSION,
  assertCodexVersion,
  codexVersion,
  compact,
  runtime,
  sanitize,
  seedCodexHome,
  sleep,
  writeCapture,
} from "./driver.mjs";

const {
  codexPermissionPickerFooterVisible,
  codexPermissionPickerOpen,
  parseCodexPermissionPickerCursor,
  parseCodexPermissionReceipt,
} = runtime;

// The reconcile + the badge label live outside `dist/runtime`; they are required
// from their own built modules so the capture reports what the PRODUCTION
// functions do, never a re-derivation.
const APP_DIR = new URL("../../../app/", import.meta.url).pathname;
const require = createRequire(APP_DIR + "package.json");
const { codexPermissionModeFromTurnContext, migrateCodexPermissionMode } = require(
  APP_DIR + "dist/shared/types/codex-settings",
);
const { codexPermissionModeLabel } = require(APP_DIR + "dist/reading-core/selectors/formatters");

const OUT_DIR = new URL(".", import.meta.url).pathname;
const ROOT = "/private/tmp/sonata-sync-2026-09/codex-read-only";
const COLS = 120;
const ROWS = 40;
const BOOT_BUDGET_MS = 90_000;
const TURN_BUDGET_MS = 180_000;
const ESC = "\x1b";
const CR = "\r";
const KILL_LINE = "\x15".repeat(40);
const MODEL_LINE_LOADING_RE = /model:\s+loading/;
// Same binding q29 arm B had to discover: hyphen separator (a `+` fails config
// load), and `ctrl-x` collides with no 0.152.x default (a collision is a hard
// exit(1) at boot).
const CYCLE_BINDING = "ctrl-x";
const CYCLE_KEY = "\x18";
// Two presses from `ask-for-approval`: → Approve for me → Read Only (q29 arm B,
// measured). Verified here per-press off the receipt rather than assumed.
const CYCLE_PRESSES_TO_READ_ONLY = 2;

const startVersion = assertCodexVersion("q35 start");

fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(ROOT, { recursive: true });

// ── settings guard (F41): the real home is READ for auth and never written ────
const realCodexHome = process.env.CODEX_HOME?.trim() || path.join(os.homedir(), ".codex");
const GUARDED = ["config.toml", "sonata.config.toml"].map((name) => {
  const file = path.join(realCodexHome, name);
  return { name, file, before: fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null };
});

const out = {
  probe: "q35-read-only-mode",
  version: startVersion,
  endVersion: null,
  versionDrift: null,
  sourceFact: {
    file: "codex-rs/tui/src/chatwidget/permission_shortcuts.rs @ rust-v0.152.0",
    cycleSet:
      "builtin_approval_presets() filtered to {read-only, auto} × reviewer {User, AutoReview}",
    labelRule:
      '("auto", User) → "Ask for approval"; ("auto", AutoReview) → "Approve for me"; else preset.label (= "Read Only")',
    consequence:
      "both modes Sonata can name ride the `auto` preset; `Read Only` is the `read-only` preset — so a read-only SANDBOX cannot be produced by any offered mode",
  },
  binding: CYCLE_BINDING,
  arms: [],
  settingsGuard: null,
};

try {
  out.arms.push(await armReadOnly());
} catch (error) {
  out.fatal = `${error?.name ?? "Error"}: ${error?.message ?? error}`;
}

// Guard verification runs whatever happened above.
out.settingsGuard = GUARDED.map(({ name, file, before }) => {
  const after = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
  return { name, unchanged: after === before, existedBefore: before !== null };
});
const guardClean = out.settingsGuard.every((row) => row.unchanged);

out.endVersion = codexVersion();
out.versionDrift = out.endVersion.includes(EXPECT_CODEX_VERSION)
  ? null
  : `END drift off ${EXPECT_CODEX_VERSION}: ${out.endVersion}`;

const capturePath = writeCapture(OUT_DIR, "q35-read-only-mode.capture.txt", out);
console.log(`\n[capture] ${capturePath}`);
printSummary(out, guardClean);
process.exit(out.versionDrift || !guardClean ? 1 : 0);

// ── the one live session both arms share ─────────────────────────────────────

async function armReadOnly() {
  const arm = { arm: "read-only", steps: [] };
  const runRoot = path.join(ROOT, "session");
  const workspace = path.join(runRoot, "cwd");
  const runtimeDir = path.join(runRoot, "runtime");
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(runtimeDir, { recursive: true });

  const codexHome = seedCodexHome(path.join(runRoot, "codex-home"));
  const configToml =
    "# q35: the #39873 permission cycle has NO default binding at 0.152.x.\n" +
    "# Bind one so the fourth mode can be reached at all.\n" +
    "[tui.keymap.chat]\n" +
    `next_permission_mode = ["${CYCLE_BINDING}"]\n`;
  fs.writeFileSync(path.join(codexHome, "config.toml"), configToml);
  arm.configToml = configToml;

  const boot = new CodexBoot({
    taskId: "task-q35-read-only",
    cwd: workspace,
    runtimeDir,
    binDir: path.join(runRoot, "bin"),
    pretrustCwd: workspace,
    codexHome,
    codexPermissionMode: "ask-for-approval",
    rows: ROWS,
    cols: COLS,
    approvalBroker: true,
  });
  const sessionsDir = path.join(codexHome, "sessions");

  try {
    await boot.start();
    arm.spawnedArgs = boot.spawnedArgs;
    if (!(await settle(boot, arm))) return arm;

    // ── TURN 1 (control): spawned ask-for-approval, no cycle pressed yet ──────
    arm.steps.push(
      await stepTurn(boot, sessionsDir, "turn-1-control", "SONATA_SL17_T1", 0),
    );

    // ── the cycle into Read Only, one press at a time, receipt-verified ───────
    const cycle = { step: "cycle-into-read-only", presses: [] };
    for (let i = 0; i < CYCLE_PRESSES_TO_READ_ONLY; i += 1) {
      const rawLenBefore = boot.raw.length;
      boot.host.writeRaw(CYCLE_KEY);
      await sleep(1500);
      const newBytes = boot.raw.slice(rawLenBefore);
      cycle.presses.push({
        press: i + 1,
        // Parsed on the press DELTA: the whole tail still holds every earlier
        // receipt, and `parseCodexPermissionReceipt` is first-match-wins over its
        // input (SL-7/D8) — so only the delta answers "what did THIS press do".
        receiptFromPressBytes: parseCodexPermissionReceipt(newBytes),
        newBytesCompact: compact(newBytes).slice(0, 240),
        containsReadOnlyLiteral: compact(newBytes).includes("•PermissionsupdatedtoReadOnly"),
      });
    }
    cycle.receiptOverWholeTail = parseCodexPermissionReceipt(boot.raw);
    cycle.screenTail = tail(boot, 5);
    arm.steps.push(cycle);

    // ── the picker, WHILE in Read Only (D6's claim, re-confirmed here because
    //    arm B's walk depends on it) ─────────────────────────────────────────
    arm.steps.push(await stepOpenPicker(boot, "picker-while-read-only"));
    arm.steps.push(await stepEsc(boot, "exit-picker-while-read-only", 2));

    // ── TURN 2: the decisive one — what does a Read Only turn project? ────────
    arm.steps.push(
      await stepTurn(boot, sessionsDir, "turn-2-read-only", "SONATA_SL17_T2", 1),
    );

    // ── ARM B: drive OUT of Read Only through the production choreography ─────
    arm.steps.push(await stepDrive(boot, "approve-for-me", "read-only"));

    // ── TURN 3: independent witness that the drive actually moved the CLI ─────
    arm.steps.push(
      await stepTurn(boot, sessionsDir, "turn-3-after-drive", "SONATA_SL17_T3", 2),
    );

    arm.rollout = findRollout(sessionsDir);
    arm.turnContexts = arm.rollout ? readTurnContexts(arm.rollout) : [];
    // The VERBATIM records get their own sibling capture, because the projected
    // view above is not enough for the job a fixture reader has: a smoke fixture
    // trimmed to the consumed axes cannot be shape-diffed against a future
    // release, and pointing it at a rollout under /private/tmp points it at
    // something that will be gone. Written every run so the pointer stays true.
    if (arm.rollout) {
      writeRawTurnContexts(OUT_DIR, arm.rollout);
    }
    arm.reconcile = arm.turnContexts.map((context, index) => {
      const reconciled = codexPermissionModeFromTurnContext(context.sandbox, context.approval);
      // The full production chain a badge rides: reconcile → the mirror the task
      // record persists (migrate is what reads it back on the next open) → label.
      const mirrored = migrateCodexPermissionMode({
        provider: "codex",
        codexPermissionMode: reconciled,
      });
      return {
        turn: index + 1,
        projection: `(${context.sandbox}, ${context.approval})`,
        reviewer: context.reviewer,
        profile: context.profile,
        reconciled,
        persistedMirror: mirrored,
        badgeLabel: mirrored ? codexPermissionModeLabel(mirrored) : null,
      };
    });
  } catch (error) {
    arm.fatal = `${error?.name ?? "Error"}: ${error?.message ?? error}`;
    arm.screenAtFailure = boot.screen();
  } finally {
    boot.dispose();
  }
  return arm;
}

// ── steps ────────────────────────────────────────────────────────────────────

async function settle(boot, arm) {
  arm.readyAtMs = await boot.waitUntil((b) => b.ready(), BOOT_BUDGET_MS);
  if (arm.readyAtMs === null) {
    arm.fatal = "composer never accepted input inside the boot budget";
    arm.bootScreen = boot.screen();
    return false;
  }
  arm.handshakeAtMs = await boot.waitUntil((b) => !MODEL_LINE_LOADING_RE.test(b.screen()), 30_000, 100);
  await sleep(600);
  arm.idleTail = tail(boot, 4);
  if (boot.ptyExited) {
    // A config the CLI refuses paints its error INTO a composer and exits, and
    // `acceptsPromptInput()` reads true for that screen (q29's measured trap).
    arm.fatal = "pty exited before the arm could drive anything";
    arm.bootScreen = boot.screen();
    arm.exitInfo = boot.exitInfo;
    return false;
  }
  return true;
}

/**
 * Submit one tool-free turn and wait for the rollout to carry `turnContextsBefore
 * + 1` records. `turn_context` is written at turn START, so this returns as soon
 * as the axis under measurement is on disk; the step then waits for the turn to
 * FINISH before returning, so the next step drives an idle CLI.
 */
async function stepTurn(boot, sessionsDir, label, sentinel, turnContextsBefore) {
  const step = { step: label, sentinel };
  const text = `Reply with exactly ${sentinel} and nothing else. Do not call any tool.`;
  boot.host.writeRaw(KILL_LINE);
  await sleep(200);
  boot.host.submitPrompt(text);

  const deadline = Date.now() + TURN_BUDGET_MS;
  let retries = 0;
  while (Date.now() < deadline && !boot.ptyExited) {
    const rollout = findRollout(sessionsDir);
    if (rollout && readTurnContexts(rollout).length > turnContextsBefore) break;
    await sleep(1500);
    // The composer can hold the text without submitting it (the CSI-u vs CR
    // ambiguity q33 hit). Only re-press while the text is still on screen.
    if (retries < 4 && boot.screen().includes(text.slice(0, 40))) {
      retries += 1;
      try {
        boot.host.writeRaw(retries % 2 === 1 ? CR : "\x1b[13u");
      } catch {
        break;
      }
    }
  }
  step.submitRetries = retries;

  const rollout = findRollout(sessionsDir);
  const contexts = rollout ? readTurnContexts(rollout) : [];
  step.turnContextCount = contexts.length;
  step.turnContext = contexts[turnContextsBefore] ?? null;
  step.landed = contexts.length > turnContextsBefore;

  // Wait for the reply so the next step drives an idle CLI, then let the footer
  // settle. A miss here is recorded, never fatal — the axis is already on disk.
  step.repliedAtMs = await boot.waitUntil((b) => b.screen().includes(sentinel), 120_000, 500);
  await boot.waitUntil((b) => b.ready(), 30_000, 250);
  await sleep(800);
  step.screenTail = tail(boot, 4);
  return step;
}

async function stepOpenPicker(boot, label) {
  boot.host.writeRaw(KILL_LINE);
  await sleep(200);
  boot.host.writeRaw("/permissions");
  await sleep(150);
  boot.host.writeRaw(CR);
  const openedAt = await boot.waitUntil((b) => codexPermissionPickerOpen(b.raw), 8000, 60);
  await boot.waitUntil((b) => codexPermissionPickerFooterVisible(b.raw), 4000, 60);
  await sleep(400);
  const screen = boot.screen();
  const lines = screen.split("\n").filter((l) => l.trim());
  return {
    step: label,
    openedAtMs: openedAt,
    headerGrid: codexPermissionPickerOpen(screen),
    footerGrid: codexPermissionPickerFooterVisible(screen),
    cursorGrid: parseCodexPermissionPickerCursor(screen),
    // The whole point of the no-`(current)` measurement: a picker that marks no
    // row is what a Read Only session paints, and the walk has to survive it.
    currentMarkerOnScreen: lines.some((l) => l.includes("(current)")),
    gridLines: lines,
  };
}

async function stepEsc(boot, label, max) {
  const step = { step: label, escs: [] };
  for (let i = 0; i < max; i += 1) {
    boot.host.writeRaw(ESC);
    await sleep(700);
    const screen = boot.screen();
    step.escs.push({
      esc: i + 1,
      pickerHeaderGrid: codexPermissionPickerOpen(screen),
      pickerFooterGrid: codexPermissionPickerFooterVisible(screen),
      acceptsPromptInput: boot.ready(),
    });
    if (!codexPermissionPickerFooterVisible(screen)) break;
  }
  return step;
}

/**
 * Drive a real permission switch through the PRODUCTION entry point — the same
 * call the renderer's session access menu makes — and read the terminal phase off
 * the `control-switch:state` events the host emits.
 */
async function stepDrive(boot, target, from) {
  const step = { step: `drive-to-${target}`, target, from };
  const before = boot.events.length;
  const phases = () =>
    boot.events
      .slice(before)
      .filter((e) => e.type === "control-switch:state")
      .map((e) => e.payload);
  step.response = boot.host.injectClaudeControlSwitch("codex-permission", target, from);
  step.settledAtMs = await boot.waitUntil(
    () => phases().some((p) => p.phase === "settled" || p.phase === "needs-attention"),
    60_000,
    150,
  );
  step.phases = phases();
  step.terminalPhase = step.phases.at(-1)?.phase ?? null;
  step.receiptOverWholeTail = parseCodexPermissionReceipt(boot.raw);
  await boot.waitUntil((b) => b.ready(), 20_000, 250);
  await sleep(600);
  step.screenTail = tail(boot, 5);
  return step;
}

// ── rollout reading (r5's shape, scoped to the isolated home) ────────────────

function findRollout(sessionsDir) {
  const files = [];
  const walk = (dir) => {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".jsonl")) files.push(full);
    }
  };
  walk(sessionsDir);
  if (files.length === 0) return null;
  // The isolated home holds exactly this probe's session(s); newest wins.
  files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return files[0];
}

/**
 * The turn_context records exactly as codex wrote them, sanitized and nothing
 * else — the durable full-shape artifact `provider-transcript.mjs`'s ADAPTED
 * fixture cites. Labels are positional and describe what the probe had done to
 * the CLI by that turn, so a reader does not have to re-derive it from the axes.
 */
function writeRawTurnContexts(outDir, rollout) {
  const labels = [
    "turn 1 — CONTROL: spawned ask-for-approval, the #39873 cycle not yet pressed",
    "turn 2 — READ ONLY: two cycle presses (Approve for me -> Read Only)",
    "turn 3 — AFTER a production injectClaudeControlSwitch drove it to approve-for-me",
  ];
  const records = fs
    .readFileSync(rollout, "utf8")
    .split("\n")
    .filter((line) => line.includes('"turn_context"'))
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter((record) => record?.type === "turn_context");
  const header = [
    "# q35 — the three turn_context records VERBATIM (codex-cli 0.152.1)",
    "#",
    "# Nothing here is trimmed; only driver.mjs sanitize() has been applied. This",
    "# exists so the ADAPTED fixture in tests/smoke/provider-transcript.mjs has a",
    "# full-shape record to point at — a fixture trimmed to the consumed axes must",
    "# never be the thing a future release is shape-diffed against.",
    "#",
    "# The shape fact the fixture trims around: read-only's sandbox_policy is a BARE",
    "# {type}, while workspace-write carries network_access / exclude_tmpdir_env_var /",
    "# exclude_slash_tmp. permission_profile.file_system also narrows per mode.",
    "",
  ].join("\n");
  const body = records
    .map((record, index) => `## ${labels[index] ?? `turn ${index + 1}`}\n${JSON.stringify(record, null, 2)}`)
    .join("\n\n");
  const outPath = path.join(outDir, "q35-read-only-mode.turn-contexts.capture.txt");
  fs.writeFileSync(outPath, sanitize(`${header}${body}`) + "\n");
  return outPath;
}

function readTurnContexts(file) {
  const out = [];
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return out;
  }
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.includes('"turn_context"')) continue;
    let record;
    try {
      record = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (record?.type !== "turn_context") continue;
    const payload = record.payload ?? {};
    const sandbox = payload.sandbox_policy;
    const profile = payload.permission_profile;
    out.push({
      // Exactly the projection `emitTurnContext` (codex-normalizer.ts) performs,
      // so what this records is what the controller's reconcile actually sees.
      sandbox: sandbox && typeof sandbox === "object" ? (sandbox.type ?? null) : (sandbox ?? null),
      approval:
        typeof payload.approval_policy === "object" && payload.approval_policy !== null
          ? `object{${Object.keys(payload.approval_policy).join(",")}}`
          : (payload.approval_policy ?? null),
      reviewer: payload.approvals_reviewer ?? null,
      profile: profile && typeof profile === "object" ? (profile.type ?? null) : (profile ?? null),
      model: payload.model ?? null,
      effort: payload.effort ?? null,
    });
  }
  return out;
}

function tail(boot, n) {
  return boot.screen().split("\n").filter((l) => l.trim()).slice(-n);
}

function printSummary(result, guardClean) {
  const say = (s = "") => console.log(s);
  say();
  say(`q35 read-only mode — codex ${result.version}`);
  say(`  source: ${result.sourceFact.file}`);
  say(`  label rule: ${result.sourceFact.labelRule}`);
  for (const arm of result.arms) {
    say(`\n[arm ${arm.arm}] ready=${arm.readyAtMs ?? "TIMEOUT"}ms${arm.fatal ? `  FATAL: ${arm.fatal}` : ""}`);
    for (const step of arm.steps) {
      if (step.presses) {
        for (const press of step.presses) {
          say(
            `  cycle press ${press.press}: receipt=${JSON.stringify(press.receiptFromPressBytes)} readOnlyLiteral=${press.containsReadOnlyLiteral}`,
          );
        }
        continue;
      }
      if (step.step?.startsWith("turn-")) {
        say(
          `  ${step.step}: landed=${step.landed} retries=${step.submitRetries} turn_context=${JSON.stringify(step.turnContext)}`,
        );
        continue;
      }
      if (step.step?.startsWith("picker-")) {
        say(
          `  ${step.step}: cursor=${JSON.stringify(step.cursorGrid)} (current)marker=${step.currentMarkerOnScreen}`,
        );
        continue;
      }
      if (step.step?.startsWith("drive-to-")) {
        say(
          `  ${step.step}: response=${JSON.stringify(step.response)} phase=${step.terminalPhase} at ${step.settledAtMs ?? "TIMEOUT"}ms`,
        );
      }
    }
    if (arm.reconcile) {
      say("\n  turn      projection                       reviewer      reconcile     badge");
      for (const row of arm.reconcile) {
        say(
          `  ${String(row.turn).padEnd(9)} ${String(row.projection).padEnd(32)} ${String(row.reviewer).padEnd(13)} ${String(row.reconciled).padEnd(13)} ${row.badgeLabel ?? "(none)"}`,
        );
      }
    }
  }
  say(`\nsettings guard: ${guardClean ? "CLEAN" : "*** DRIFT ***"}`);
  if (result.versionDrift) say(`*** ${result.versionDrift} ***`);
}
