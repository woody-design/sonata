// Q29 (2026-09 sync, SL-7) — the CODEX `/permissions` picker, the Full Access
// consent dialog, and the #39873 permission-cycle shortcut, at 0.152.1.
//
// THREE QUESTIONS, and they are separable:
//
//   PICKER  — header, row set, cursor grammar, footer keys, and the
//             `• Permissions updated to <label>` receipt. The 0.146.0 baseline
//             says three rows (`Ask for approval` / `Approve for me` /
//             `Full Access`). The 0.152 source's own shortcut code enumerates
//             `builtin_approval_presets()` and keeps only `read-only` and
//             `auto`, which is a DIFFERENT set from the three Sonata models —
//             so whether a fourth row now paints is a live question, not a
//             formality: `CODEX_ROW_ORDER` is a fixed 0/1/2 map and an inserted
//             row shifts every arrow the choreography presses.
//
//   EXITS   — at 0.146.0 the consent dialog's two exits were ASYMMETRIC and the
//             park+relay red line is built on that shape: Esc landed on the
//             COMPOSER (the whole `/permissions` flow gone), while Enter on the
//             `Cancel` row landed back on the STILL-OPEN picker. Both are
//             re-driven here, each from its own freshly opened picker, and the
//             landing screen is captured verbatim — because "the relay's Cancel
//             row leaves a picker open" is a fact the drawer's dismiss path
//             depends on.
//
//   CYCLE   — #39873. The SOURCE answer is already decisive and is recorded in
//             findings rather than guessed at here: at `rust-v0.152.0`
//             `keymap.rs` ships `next_permission_mode: default_bindings![]` and
//             `previous_permission_mode: default_bindings![]` — the cycle has NO
//             DEFAULT BINDING and is unreachable unless a user writes
//             `tui.keymap.chat.next_permission_mode` into their own config. So
//             arm B CONFIGURES one and drives it, which is the only way to
//             answer the question that actually matters to Sonata: when a user
//             HAS bound it and uses it natively, does anything Sonata reads
//             move? (The codex mirror has no hook-payload permission feed — the
//             picker receipt is the sole confirmation channel — so a cycle that
//             prints no receipt is a silent mirror-staleness class, the codex
//             sibling of SL-5's claude finding.)
//
// RED LINE, held: the Full Access consent is never granted in the PRODUCTION
// arm. Arm A only ever Escs it or answers Cancel. The grant — and therefore the
// third receipt string — is taken in arm B, which runs in an isolated
// CODEX_HOME against a scratch cwd, so no real profile or ledger is touched.
//
// No turn is ever submitted: `/permissions` opens a picker, and every arm ends
// on a composer.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
  codexPermissionConsentDialogOpen,
  codexPermissionPickerFooterVisible,
  codexPermissionPickerOpen,
  parseCodexConsentCursor,
  parseCodexPermissionPickerCursor,
  parseCodexPermissionReceipt,
} = runtime;

const OUT_DIR = new URL(".", import.meta.url).pathname;
const ROOT = "/private/tmp/sonata-sync-2026-09/codex-permissions";
const COLS = 120;
const ROWS = 40;
const BOOT_BUDGET_MS = 90_000;
const ESC = "\x1b";
const CR = "\r";
const ARROW_DOWN = "\x1b[B";
const ARROW_UP = "\x1b[A";
const KILL_LINE = "\x15".repeat(40);
const MODEL_LINE_LOADING_RE = /model:\s+loading/;
/** The binding arm B writes into the isolated config so the #39873 cycle has
 *  something to be pressed with. Two rounds of measured rejection got here, and
 *  both are findings about how hard this shortcut is to reach at all:
 *
 *    1. SEPARATOR. `ctrl+g` is rejected at config load — `Error loading
 *       config.toml: data did not match any variant of untagged enum
 *       KeybindingsSpec in tui.keymap.chat.next_permission_mode`. The accepted
 *       spelling is a HYPHEN (`config/src/tui_keymap.rs:60-66`: `"ctrl-a"` /
 *       `"ctrl-x ctrl-s"`).
 *    2. CONFLICT. `ctrl-g` IS a default binding for another chat action, and the
 *       keymap's conflict validator refuses the whole config: "… use the same
 *       key. Set unique keys in ~/.codex/config.toml and retry."
 *
 *  `ctrl-x` appears in none of the 0.152.0 default binding tables and is a
 *  single unambiguous byte over a pty (unlike an Alt binding, which arrives as
 *  ESC + char and can split across reads). */
const CYCLE_BINDING = "ctrl-x";
const CYCLE_KEY = "\x18";
/** Run one arm only (`production` | `cycle-shortcut`) — a re-run of the cheap
 *  half must not re-drive the expensive one. */
const ONLY_ARM = process.env.Q29_ARM ?? null;

const startVersion = assertCodexVersion("q29 start");

fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(ROOT, { recursive: true });

const realCodexHome = process.env.CODEX_HOME?.trim() || path.join(os.homedir(), ".codex");
const realProfilePath = path.join(realCodexHome, "sonata.config.toml");
const profileBackup = fs.existsSync(realProfilePath)
  ? fs.readFileSync(realProfilePath, "utf8")
  : null;

const out = {
  probe: "q29-permissions-consent-walk",
  version: startVersion,
  endVersion: null,
  versionDrift: null,
  sourceFact: {
    what: "#39873 permission-cycle default binding",
    file: "codex-rs/tui/src/keymap.rs (rust-v0.152.0 shallow clone)",
    finding:
      "next_permission_mode: default_bindings![] / previous_permission_mode: default_bindings![]" +
      " — NO default binding; reachable only via tui.keymap.chat.next_permission_mode",
    cycleSet:
      "chatwidget/permission_shortcuts.rs keeps only presets read-only|auto, ×" +
      " reviewer User|AutoReview — a set that is NOT the picker's row set",
  },
  arms: [],
};

try {
  if (!ONLY_ARM || ONLY_ARM === "production") out.arms.push(await armProduction());
  if (!ONLY_ARM || ONLY_ARM === "cycle-shortcut") out.arms.push(await armCycleShortcut());
} catch (error) {
  out.fatal = `${error instanceof Error ? error.stack : String(error)}`;
} finally {
  if (profileBackup !== null) fs.writeFileSync(realProfilePath, profileBackup);
}

out.endVersion = codexVersion();
out.versionDrift = out.endVersion.includes(EXPECT_CODEX_VERSION)
  ? null
  : `drifted off ${EXPECT_CODEX_VERSION}: start=${out.version} end=${out.endVersion}`;

// A filtered run writes its own file so a partial re-run cannot clobber the
// full capture the findings cite.
const captureName = ONLY_ARM
  ? `q29-permissions-consent-walk.${ONLY_ARM}.capture.txt`
  : "q29-permissions-consent-walk.capture.txt";
const capturePath = writeCapture(OUT_DIR, captureName, out);
console.log(sanitize(summarize(out)));
console.log(`\ncapture: ${capturePath}`);
if (out.versionDrift) {
  console.error(`VERSION DRIFT: ${out.versionDrift}`);
  process.exitCode = 2;
}
if (out.fatal) {
  console.error(`FATAL: ${out.fatal}`);
  process.exitCode = 1;
}

// ── arm A: the production shape ─────────────────────────────────────────────

async function armProduction() {
  const arm = { arm: "production", steps: [] };
  const runRoot = path.join(ROOT, "production");
  const workspace = path.join(runRoot, "cwd");
  const runtimeDir = path.join(runRoot, "runtime");
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(runtimeDir, { recursive: true });

  const boot = new CodexBoot({
    taskId: "task-q29-production",
    cwd: workspace,
    runtimeDir,
    binDir: path.join(os.homedir(), ".sonata", "bin"),
    pretrustCwd: workspace,
    codexPermissionMode: "ask-for-approval",
    rows: ROWS,
    cols: COLS,
    approvalBroker: true,
  });

  try {
    await boot.start();
    if (!(await settle(boot, arm))) return arm;

    // 1 ── the picker, verbatim, on both channels.
    arm.steps.push(await stepOpenPicker(boot, "picker-structure"));
    // 2 ── EXIT A: Esc straight out of the picker.
    arm.steps.push(await stepEsc(boot, "exit-picker-esc", 1));

    // 3 ── walk to Full Access and open the consent.
    arm.steps.push(await stepOpenPicker(boot, "picker-reopen-for-consent"));
    arm.steps.push(await stepWalkTo(boot, "full-access"));
    arm.steps.push(await stepConfirmIntoConsent(boot));
    // 4 ── EXIT B: Esc on the consent — 0.146.0 landed on the COMPOSER.
    arm.steps.push(await stepEsc(boot, "exit-consent-esc", 2));

    // 5 ── EXIT C: the consent's own Cancel row — 0.146.0 landed back on the
    //      STILL-OPEN picker. This is the asymmetry the relay is built on.
    arm.steps.push(await stepOpenPicker(boot, "picker-reopen-for-cancel"));
    arm.steps.push(await stepWalkTo(boot, "full-access"));
    arm.steps.push(await stepConfirmIntoConsent(boot));
    arm.steps.push(await stepConsentCancelRow(boot));
    arm.steps.push(await stepEsc(boot, "exit-after-cancel", 2));

    // 6 ── the receipts, on the two rows that need no consent. Ends back on
    //      ask-for-approval so the session is left as it spawned.
    arm.steps.push(await stepSwitchTo(boot, "approve-for-me"));
    arm.steps.push(await stepSwitchTo(boot, "ask-for-approval"));
  } catch (error) {
    arm.fatal = `${error instanceof Error ? error.stack : String(error)}`;
  } finally {
    boot.dispose();
    await sleep(400);
  }
  return arm;
}

// ── arm B: the #39873 cycle, with a binding written for it ──────────────────

async function armCycleShortcut() {
  const arm = { arm: "cycle-shortcut", binding: CYCLE_BINDING, steps: [] };
  const runRoot = path.join(ROOT, "cycle");
  const workspace = path.join(runRoot, "cwd");
  const runtimeDir = path.join(runRoot, "runtime");
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(runtimeDir, { recursive: true });

  // Isolated home, auth seeded, no user config.toml — then the ONE key this arm
  // is about. Sonata's own profile is written into this home by `buildArgs`.
  const codexHome = seedCodexHome(path.join(runRoot, "codex-home"));
  const configToml =
    "# q29 arm B: the #39873 permission cycle has NO default binding at 0.152.x.\n" +
    "# Bind one so the shortcut can be driven at all.\n" +
    "[tui.keymap.chat]\n" +
    `next_permission_mode = ["${CYCLE_BINDING}"]\n`;
  fs.writeFileSync(path.join(codexHome, "config.toml"), configToml);
  arm.configToml = configToml;

  const boot = new CodexBoot({
    taskId: "task-q29-cycle",
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

  try {
    await boot.start();
    if (!(await settle(boot, arm))) return arm;

    // CONTROL: the same press with no picker open, three times, watching BOTH
    // the screen (does the mode indicator move?) and the stream (does a
    // `• Permissions updated to …` receipt print?).
    for (let i = 0; i < 3; i += 1) {
      const before = { screenTail: tail(boot, 8), receipt: parseCodexPermissionReceipt(boot.raw) };
      const rawLenBefore = boot.raw.length;
      boot.host.writeRaw(CYCLE_KEY);
      await sleep(1500);
      const newBytes = boot.raw.slice(rawLenBefore);
      arm.steps.push({
        step: `cycle-press-${i + 1}`,
        beforeTail: before.screenTail,
        afterTail: tail(boot, 8),
        // The receipt parser reads the WHOLE rolling tail in production; here the
        // decisive question is whether THIS press printed one, so the delta is
        // parsed on its own as well.
        receiptFromPressBytes: parseCodexPermissionReceipt(newBytes),
        receiptFromWholeTail: parseCodexPermissionReceipt(boot.raw),
        newBytesCompact: compact(newBytes).slice(0, 400),
        pickerOpen: codexPermissionPickerOpen(boot.screen()),
      });
      // RUN 1 measured the cycle's second stop as `Read Only` — a mode the
      // picker has no row for and `CodexPermissionMode` cannot name. What the
      // PICKER shows while the CLI sits in it decides whether the exposure is
      // "the mirror is stale" (survivable — the drive reads its cursor by TEXT)
      // or "the drive is blind" (not). So catch it in the act.
      if (i === 1) {
        arm.steps.push(await stepOpenPicker(boot, "picker-while-read-only"));
        arm.steps.push(await stepEsc(boot, "exit-picker-while-read-only", 2));
      }
    }

    // Then the grant path, taken HERE (isolated) rather than in production:
    // walk to Full Access, confirm, answer the consent's row 1, and read the
    // third receipt string.
    arm.steps.push(await stepOpenPicker(boot, "cycle-arm-picker"));
    arm.steps.push(await stepWalkTo(boot, "full-access"));
    arm.steps.push(await stepConfirmIntoConsent(boot));
    arm.steps.push(await stepConsentGrantRow(boot));
  } catch (error) {
    arm.fatal = `${error instanceof Error ? error.stack : String(error)}`;
  } finally {
    boot.dispose();
    await sleep(400);
  }
  return arm;
}

// ── steps ───────────────────────────────────────────────────────────────────

async function settle(boot, arm) {
  arm.readyAtMs = await boot.waitUntil((b) => b.ready(), BOOT_BUDGET_MS);
  if (arm.readyAtMs === null) {
    arm.fatal = "composer never accepted input inside the boot budget";
    arm.bootScreen = boot.screen();
    return false;
  }
  arm.handshakeAtMs = await boot.waitUntil(
    (b) => !MODEL_LINE_LOADING_RE.test(b.screen()),
    30_000,
    100,
  );
  await sleep(600);
  arm.idleTail = tail(boot, 4);
  // A config the CLI refuses paints its error INTO a composer and then exits —
  // `acceptsPromptInput()` reads true for that screen, so readiness alone is not
  // evidence the arm can be driven. Bail with the screen rather than throwing
  // `No PTY process is running` three steps later (measured twice while getting
  // the keymap spelling right).
  if (boot.ptyExited) {
    arm.fatal = "pty exited before the arm could drive anything";
    arm.bootScreen = boot.screen();
    arm.exitInfo = boot.exitInfo;
    return false;
  }
  return true;
}

/** Type bare `/permissions` + a deferred Enter (production shape), then capture
 *  the opened picker on BOTH channels. */
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
  return {
    step: label,
    openedAtMs: openedAt,
    headerGrid: codexPermissionPickerOpen(screen),
    headerStream: codexPermissionPickerOpen(boot.raw),
    footerGrid: codexPermissionPickerFooterVisible(screen),
    footerStream: codexPermissionPickerFooterVisible(boot.raw),
    cursorGrid: parseCodexPermissionPickerCursor(screen),
    cursorStream: parseCodexPermissionPickerCursor(boot.raw),
    gridLines: screen.split("\n").filter((l) => l.trim()),
  };
}

/** Arrow to `target` using the same read-cursor-then-press loop production runs
 *  (`decideCodexNav`), recording every press on both channels. Bounded. */
async function stepWalkTo(boot, target) {
  const step = { step: `walk-to-${target}`, presses: [] };
  for (let i = 0; i < 6; i += 1) {
    const screen = boot.screen();
    const cursor = parseCodexPermissionPickerCursor(screen);
    if (cursor === target) {
      step.landedOn = cursor;
      step.presses.push({ press: i, cursorGrid: cursor, note: "already on target" });
      return step;
    }
    const order = runtime.CODEX_ROW_ORDER;
    if (cursor == null || order[target] === undefined || order[cursor] === undefined) {
      step.failed = `cursor unreadable or unknown row: ${cursor}`;
      step.gridLines = screen.split("\n").filter((l) => l.trim());
      return step;
    }
    const down = order[target] > order[cursor];
    boot.host.writeRaw(down ? ARROW_DOWN : ARROW_UP);
    await sleep(400);
    step.presses.push({
      press: i + 1,
      from: cursor,
      down,
      afterGrid: parseCodexPermissionPickerCursor(boot.screen()),
      afterStream: parseCodexPermissionPickerCursor(boot.raw),
    });
  }
  step.landedOn = parseCodexPermissionPickerCursor(boot.screen());
  step.failed = step.landedOn === target ? null : "nav bound hit";
  return step;
}

/** Enter on the Full Access row → the consent dialog. Captured on BOTH channels
 *  (2026-08 measured the STREAM structurally blind here — the cell-diff repaint
 *  — which is why the production predicate reads the grid). */
async function stepConfirmIntoConsent(boot) {
  const rawLenBefore = boot.raw.length;
  boot.host.writeRaw(CR);
  await sleep(1400);
  const screen = boot.screen();
  return {
    step: "confirm-into-consent",
    consentOpenGrid: codexPermissionConsentDialogOpen(screen),
    consentOpenStream: codexPermissionConsentDialogOpen(boot.raw),
    consentCursorGrid: parseCodexConsentCursor(screen),
    consentCursorStream: parseCodexConsentCursor(boot.raw),
    receiptOnConfirm: parseCodexPermissionReceipt(boot.raw.slice(rawLenBefore)),
    pickerHeaderStillGrid: codexPermissionPickerOpen(screen),
    footerGrid: codexPermissionPickerFooterVisible(screen),
    gridLines: screen.split("\n").filter((l) => l.trim()),
    streamTailCompact: compact(boot.raw.slice(rawLenBefore)).slice(0, 600),
  };
}

/** Navigate the consent to row 2 (`Cancel`) and confirm it — the exit whose
 *  landing screen the drawer's dismiss path depends on. */
async function stepConsentCancelRow(boot) {
  const step = { step: "consent-cancel-row", presses: [] };
  for (let i = 0; i < 3; i += 1) {
    const cursor = parseCodexConsentCursor(boot.screen());
    if (cursor === 2) break;
    boot.host.writeRaw(ARROW_DOWN);
    await sleep(400);
    step.presses.push({ press: i + 1, from: cursor, after: parseCodexConsentCursor(boot.screen()) });
  }
  step.cursorBeforeEnter = parseCodexConsentCursor(boot.screen());
  const rawLenBefore = boot.raw.length;
  boot.host.writeRaw(CR);
  await sleep(1500);
  const screen = boot.screen();
  step.after = {
    consentOpenGrid: codexPermissionConsentDialogOpen(screen),
    pickerHeaderGrid: codexPermissionPickerOpen(screen),
    pickerFooterGrid: codexPermissionPickerFooterVisible(screen),
    pickerCursorGrid: parseCodexPermissionPickerCursor(screen),
    receipt: parseCodexPermissionReceipt(boot.raw.slice(rawLenBefore)),
    acceptsPromptInput: boot.ready(),
    gridLines: screen.split("\n").filter((l) => l.trim()),
  };
  return step;
}

/** The GRANT — arm B only (isolated home, scratch cwd). Row 1 of the consent. */
async function stepConsentGrantRow(boot) {
  const step = { step: "consent-grant-row" };
  for (let i = 0; i < 3; i += 1) {
    const cursor = parseCodexConsentCursor(boot.screen());
    if (cursor === 1) break;
    boot.host.writeRaw(ARROW_UP);
    await sleep(400);
  }
  step.cursorBeforeEnter = parseCodexConsentCursor(boot.screen());
  const rawLenBefore = boot.raw.length;
  boot.host.writeRaw(CR);
  await sleep(2000);
  const screen = boot.screen();
  const newBytes = boot.raw.slice(rawLenBefore);
  step.receipt = parseCodexPermissionReceipt(newBytes);
  step.receiptWholeTail = parseCodexPermissionReceipt(boot.raw);
  step.newBytesCompact = compact(newBytes).slice(0, 600);
  step.consentOpenGrid = codexPermissionConsentDialogOpen(screen);
  step.acceptsPromptInput = boot.ready();
  step.gridLines = screen.split("\n").filter((l) => l.trim());
  return step;
}

/** Esc `max` times, recording where each one lands. */
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
      pickerFooterStream: codexPermissionPickerFooterVisible(boot.raw),
      consentOpenGrid: codexPermissionConsentDialogOpen(screen),
      acceptsPromptInput: boot.ready(),
      tail: screen.split("\n").filter((l) => l.trim()).slice(-4),
    });
    if (!codexPermissionPickerFooterVisible(screen)) break;
  }
  return step;
}

/** Open the picker, walk to `target`, Enter, and read the receipt. */
async function stepSwitchTo(boot, target) {
  const step = { step: `switch-to-${target}` };
  step.open = await stepOpenPicker(boot, `open-for-${target}`);
  step.walk = await stepWalkTo(boot, target);
  const rawLenBefore = boot.raw.length;
  boot.host.writeRaw(CR);
  await sleep(1800);
  const newBytes = boot.raw.slice(rawLenBefore);
  const screen = boot.screen();
  step.receipt = parseCodexPermissionReceipt(newBytes);
  step.receiptWholeTail = parseCodexPermissionReceipt(boot.raw);
  step.receiptLines = cleanLines(newBytes).filter((l) => l.includes("Permissions"));
  step.newBytesCompact = compact(newBytes).slice(0, 500);
  step.pickerClosedGrid = !codexPermissionPickerFooterVisible(screen);
  step.acceptsPromptInput = boot.ready();
  step.tail = screen.split("\n").filter((l) => l.trim()).slice(-5);
  return step;
}

// ── plumbing ────────────────────────────────────────────────────────────────

function tail(boot, n) {
  return boot.screen().split("\n").filter((l) => l.trim()).slice(-n);
}

function cleanLines(raw) {
  return raw
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)|\x1b[@-_]/g, "")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

function summarize(out) {
  const lines = [`q29 permissions/consent/cycle — codex ${out.version}`];
  if (out.fatal) lines.push(`FATAL: ${out.fatal}`);
  lines.push(`\nSOURCE FACT (${out.sourceFact.file}):`);
  lines.push(`  ${out.sourceFact.finding}`);
  lines.push(`  ${out.sourceFact.cycleSet}`);
  for (const arm of out.arms) {
    lines.push(`\n══ arm ${arm.arm}  ready=${arm.readyAtMs}ms handshake=${arm.handshakeAtMs}ms`);
    if (arm.fatal) lines.push(`  FATAL: ${arm.fatal}`);
    if (arm.binding) lines.push(`  binding written: tui.keymap.chat.next_permission_mode = ["${arm.binding}"]`);
    for (const step of arm.steps ?? []) {
      lines.push(`\n── ${step.step}`);
      if (step.gridLines) {
        lines.push(
          `  headerGrid=${step.headerGrid} headerStream=${step.headerStream} ` +
            `footerGrid=${step.footerGrid} cursorGrid=${step.cursorGrid} cursorStream=${step.cursorStream}`,
        );
        for (const l of step.gridLines) lines.push(`    | ${l}`);
      }
      if (step.presses) {
        for (const p of step.presses) {
          lines.push(`  press ${p.press}: ${p.from ?? p.cursorGrid} → grid=${p.afterGrid ?? p.after} stream=${p.afterStream ?? ""} ${p.note ?? ""}`);
        }
        if (step.landedOn !== undefined) lines.push(`  landedOn=${step.landedOn} failed=${step.failed ?? "no"}`);
      }
      if (step.consentOpenGrid !== undefined && step.step === "confirm-into-consent") {
        lines.push(
          `  consentOpen grid=${step.consentOpenGrid} stream=${step.consentOpenStream} | ` +
            `cursor grid=${step.consentCursorGrid} stream=${step.consentCursorStream} | ` +
            `receiptOnConfirm=${JSON.stringify(step.receiptOnConfirm)}`,
        );
        for (const l of step.gridLines) lines.push(`    | ${l}`);
        lines.push(`  stream bytes (compacted): ${step.streamTailCompact}`);
      }
      if (step.after) {
        lines.push(`  cursorBeforeEnter=${step.cursorBeforeEnter}`);
        lines.push(
          `  AFTER: consentOpen=${step.after.consentOpenGrid} pickerHeader=${step.after.pickerHeaderGrid} ` +
            `pickerFooter=${step.after.pickerFooterGrid} pickerCursor=${step.after.pickerCursorGrid} ` +
            `receipt=${JSON.stringify(step.after.receipt)} ready=${step.after.acceptsPromptInput}`,
        );
        for (const l of step.after.gridLines) lines.push(`    | ${l}`);
      }
      if (step.escs) {
        for (const e of step.escs) {
          lines.push(
            `  esc#${e.esc}: pickerHeader=${e.pickerHeaderGrid} pickerFooter=${e.pickerFooterGrid} ` +
              `(stream ${e.pickerFooterStream}) consentOpen=${e.consentOpenGrid} ready=${e.acceptsPromptInput}`,
          );
          for (const l of e.tail) lines.push(`      | ${l}`);
        }
      }
      if (step.receipt !== undefined && step.step.startsWith("switch-to")) {
        lines.push(`  open cursor=${step.open.cursorGrid} walk landedOn=${step.walk.landedOn}`);
        lines.push(`  RECEIPT (press delta) = ${JSON.stringify(step.receipt)}  wholeTail=${JSON.stringify(step.receiptWholeTail)}`);
        for (const l of step.receiptLines) lines.push(`    verbatim | ${l}`);
        lines.push(`  pickerClosed=${step.pickerClosedGrid} ready=${step.acceptsPromptInput}`);
        for (const l of step.tail) lines.push(`    | ${l}`);
      }
      if (step.step === "consent-grant-row") {
        lines.push(`  cursorBeforeEnter=${step.cursorBeforeEnter} RECEIPT=${JSON.stringify(step.receipt)} wholeTail=${JSON.stringify(step.receiptWholeTail)}`);
        lines.push(`  consentStillOpen=${step.consentOpenGrid} ready=${step.acceptsPromptInput}`);
        lines.push(`  bytes: ${step.newBytesCompact}`);
        for (const l of step.gridLines) lines.push(`    | ${l}`);
      }
      if (step.step.startsWith("cycle-press")) {
        lines.push(
          `  receipt(press delta)=${JSON.stringify(step.receiptFromPressBytes)} ` +
            `receipt(whole tail)=${JSON.stringify(step.receiptFromWholeTail)} pickerOpen=${step.pickerOpen}`,
        );
        lines.push("  before:");
        for (const l of step.beforeTail) lines.push(`    | ${l}`);
        lines.push("  after:");
        for (const l of step.afterTail) lines.push(`    | ${l}`);
        lines.push(`  new bytes: ${step.newBytesCompact}`);
      }
    }
  }
  return lines.join("\n");
}
