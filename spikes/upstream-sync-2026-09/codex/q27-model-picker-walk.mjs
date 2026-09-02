// Q27 (2026-09 sync, SL-7) — the CODEX `/model` picker, re-walked STRUCTURALLY
// at 0.152.1 under Sonata's own spawn shape.
//
// QUESTION, in four parts, none of which the 0.146.0 baseline can answer any
// more (ratatui 0.30 + the 0.152.0 app-server picker refresh):
//
//   DEPTH   — is this still the two-level `Select Model and Effort` picker the
//             choreography is built on, or has this account been moved to the
//             catalog shape with an auto-mode level 1? The whole S4 state
//             machine (`opening → navigating-l1 → opening-l2 → navigating-l2`)
//             is a bet on the answer, so it is measured before anything else.
//   ROWS    — the live row set, their digits, and which marker each carries.
//             `(current)` and `(default)` mean different things to the parser:
//             the level-2 regex admits BOTH, the level-1 regex admits only
//             `(current)`. If a `(default)` ever appears on a MODEL row the
//             level-1 parse silently drops the marker.
//   REFRESH — #41467: the picker re-renders from the app server AFTER it opens.
//             Two sub-questions, and they have different blast radii:
//               (a) can the ROW SET change under an in-progress walk? The
//                   choreography captures `order`/`byDigit` ONCE from the
//                   opening frame and then navigates on that snapshot, so a
//                   post-capture reshuffle would make every subsequent arrow a
//                   blind press against a stale map.
//               (b) does the refresh move the HIGHLIGHT? `advanceCodexModelNav`
//                   treats any cursor that is neither `awaitingCursor` nor
//                   `lastCursor` as an unexpected jump and rolls back.
//   CHANNEL — the S4 parsers read the STREAM (whole-scan). The 2026-08 consent
//             dialog had to move to the GRID because codex repainted it as a
//             cell diff that never retransmits already-correct cells. Every
//             parse below is therefore run on BOTH substrates in the same
//             instant, so a stream that has gone blind shows up as a
//             disagreement rather than as a mystery timeout later.
//
// READ-ONLY. This probe NEVER confirms a model row into a receipt: every arm
// ends in Esc(es) and verifies the composer came back. The tier receipts are
// q28's job, on purpose — a structural measurement that also mutates session
// state cannot be re-run cleanly.
//
// HAZARD (standing, this program): never send `/model <arg>` as a chat line —
// codex has no arg form and would submit it as a prompt and burn a turn. Bare
// `/model` + a deferred Enter, exactly as the production choreography types it.
//
// Scratch lives in /private/tmp (never the agent scratchpad, whose path embeds
// the username): these frames become findings and the pre-push fence scans blob
// content.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CodexBoot,
  EXPECT_CODEX_VERSION,
  assertCodexVersion,
  codexVersion,
  cleanTerminal,
  compact,
  runtime,
  sanitize,
  sleep,
  writeCapture,
} from "./driver.mjs";

const {
  codexModelPickerFooterVisible,
  codexModelPickerLevel1Open,
  codexModelPickerLevel2Open,
  detectIdlePromptForProvider,
  parseCodexModelLevel1,
  parseCodexModelLevel2,
} = runtime;

const OUT_DIR = new URL(".", import.meta.url).pathname;
const ROOT = "/private/tmp/sonata-sync-2026-09/codex-model-picker";
const COLS = 120;
const ROWS = 40;
const BOOT_BUDGET_MS = 90_000;
/** How long an OPENED picker is watched with NO key pressed. The app-server
 *  refresh (#41467) is asynchronous and network-bound, so the window has to be
 *  long enough that "it never refreshed" is a measurement rather than an
 *  impatience artifact. 20s is ~5x the observed boot handshake. */
const PICKER_HOLD_MS = 20_000;
const ESC = "\x1b";
const CR = "\r";
const ARROW_DOWN = "\x1b[B";
const ARROW_UP = "\x1b[A";
/** The production composer clear (`clearComposerBeforeTypedCommand`): Ctrl-U
 *  (KILL_LINE) at the CLI_INPUT_CLEAR_MIN_KILLS floor. Every typed command in
 *  this probe is preceded by it, exactly as the choreography does — RUN 1 of
 *  this probe proved why: an Enter swallowed during the app-server handshake
 *  left `/model` sitting in the composer, and the NEXT arm's typing produced
 *  `/model/model`. */
const KILL_LINE = "\x15".repeat(40);
/** The app-server handshake gap. Codex paints its box + composer within ~150ms
 *  (a Rust binary), but the box's `model:` / `directory:` rows read `loading`
 *  until the app server answers — and RUN 1 MEASURED that an Enter delivered in
 *  that gap does not open the picker. Every arm waits this out and the delta is
 *  itself recorded. */
const MODEL_LINE_LOADING_RE = /model:\s+loading/;

const startVersion = assertCodexVersion("q27 start");

fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(ROOT, { recursive: true });
const workspace = path.join(ROOT, "cwd");
const runtimeDir = path.join(ROOT, "runtime");
fs.mkdirSync(workspace, { recursive: true });
fs.mkdirSync(runtimeDir, { recursive: true });
fs.writeFileSync(path.join(workspace, "README.md"), "q27 model picker probe workspace\n");

// The production spawn shape regenerates the user's REAL sonata.config.toml and
// adds this scratch cwd to its trust ledger. Snapshot it so the probe cannot
// linger there (the q20 discipline).
const realCodexHome = process.env.CODEX_HOME?.trim() || path.join(os.homedir(), ".codex");
const realProfilePath = path.join(realCodexHome, "sonata.config.toml");
const profileBackup = fs.existsSync(realProfilePath)
  ? fs.readFileSync(realProfilePath, "utf8")
  : null;

const out = {
  probe: "q27-model-picker-walk",
  version: startVersion,
  endVersion: null,
  versionDrift: null,
  workspace,
  args: null,
  idle: null,
  steps: [],
};

const boot = new CodexBoot({
  taskId: "task-q27",
  cwd: workspace,
  runtimeDir,
  binDir: path.join(os.homedir(), ".sonata", "bin"),
  pretrustCwd: workspace,
  rows: ROWS,
  cols: COLS,
  approvalBroker: true,
});

try {
  const started = await boot.start();
  out.args = started.args;

  const readyAt = await boot.waitUntil((b) => b.ready(), BOOT_BUDGET_MS);
  if (readyAt === null) {
    out.fatal = "composer never accepted input inside the boot budget";
    out.bootScreen = boot.screen();
  } else {
    // Sonata's readiness and codex's app-server handshake are DIFFERENT events;
    // measure the gap rather than assume it away (RUN 1's lesson).
    out.readyAtMs = readyAt;
    const handshakeAt = await boot.waitUntil(
      (b) => !MODEL_LINE_LOADING_RE.test(b.screen()),
      30_000,
      100,
    );
    out.appServerHandshakeAtMs = handshakeAt;
    out.readyBeforeHandshakeByMs = handshakeAt === null ? null : handshakeAt - readyAt;

    // ── Objective 5: the idle composer, before anything is opened ────────────
    out.idle = snapshotIdle(boot, boot.at());

    // ── Step 1: DEPTH + ROWS + REFRESH, with no key pressed ─────────────────
    out.steps.push(await stepOpenAndHold(boot));

    // ── Step 2: does a walk survive an in-flight refresh? ───────────────────
    out.steps.push(await stepFastWalk(boot));

    // ── Step 3: level 2 — enter it, catalogue it, Esc back out ──────────────
    out.steps.push(await stepLevel2(boot));

    out.idleAfter = snapshotIdle(boot, boot.at());
  }
} catch (error) {
  out.fatal = `${error instanceof Error ? error.stack : String(error)}`;
} finally {
  boot.dispose();
  if (profileBackup !== null) {
    fs.writeFileSync(realProfilePath, profileBackup);
  }
  await sleep(400);
}

// END pin: RECORD a drift, save the capture anyway, exit non-zero after (the
// SL-4 method note — a mid-run auto-update must not throw away a measurement).
out.endVersion = codexVersion();
out.versionDrift = out.endVersion.includes(EXPECT_CODEX_VERSION)
  ? null
  : `drifted off ${EXPECT_CODEX_VERSION}: start=${out.version} end=${out.endVersion}`;

const capturePath = writeCapture(OUT_DIR, "q27-model-picker-walk.capture.txt", out);
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

// ── steps ───────────────────────────────────────────────────────────────────

/** The idle composer as BOTH channels see it: the footer line (objective 5 —
 *  now load-bearing for the SL-6 boot latch via `idlePromptModelHints`), the
 *  composer prompt glyph actually painted, and the production idle scrape. */
function snapshotIdle(boot, atMs) {
  const screen = boot.screen();
  const lines = screen.split("\n").filter((line) => line.trim());
  return {
    atMs,
    // The last few rendered rows: composer + footer. Verbatim, not compacted —
    // the glyph and the ` · ` separators are the measurement.
    tailLines: lines.slice(-6),
    composerGlyphsSeen: [">", "›", "❯", "»"].filter((g) => screen.includes(g)),
    idleScrapeGrid: detectIdlePromptForProvider(screen, "codex"),
    idleScrapeStream: detectIdlePromptForProvider(boot.raw, "codex"),
    acceptsPromptInput: boot.ready(),
  };
}

/**
 * Open the picker and WATCH it, pressing nothing. Records every distinct frame
 * (grid) with the production level-1/level-2 parses of BOTH substrates, so the
 * async refresh — if it happens — appears as a row-set or cursor change between
 * two snapshots of an untouched picker.
 */
async function stepOpenAndHold(boot) {
  const step = { step: "open-and-hold", why: "DEPTH + ROWS + REFRESH with no key pressed", frames: [] };
  step.open = await openModelPicker(boot);

  const deadline = Date.now() + PICKER_HOLD_MS;
  let lastKey = null;
  while (Date.now() < deadline) {
    const frame = captureFrame(boot);
    const key = JSON.stringify([frame.gridCompact, frame.l1Grid, frame.l1Stream]);
    if (key !== lastKey) {
      lastKey = key;
      step.frames.push(frame);
    }
    await sleep(150);
  }

  step.distinctFrames = step.frames.length;
  step.rowSetChanged = rowSetSignature(step.frames.at(0)) !== rowSetSignature(step.frames.at(-1));
  step.cursorChanged = step.frames.at(0)?.l1Grid.cursor !== step.frames.at(-1)?.l1Grid.cursor;
  step.rollback = await escapeToComposer(boot, 2);
  return step;
}

/**
 * Re-open and start arrowing IMMEDIATELY — the moment the level-1 header is on
 * screen, without waiting for the footer the production capture waits for. This
 * is the arm that can catch a refresh landing UNDER a walk: the presses go out
 * during the window in which the app server is still expected to answer.
 *
 * Each press records the cursor BEFORE and AFTER on both substrates plus the
 * full row order, so a reshuffle is visible as a digit moving under a row id.
 */
async function stepFastWalk(boot) {
  const step = { step: "fast-walk", why: "REFRESH (b): can a refresh land under an in-progress walk", presses: [] };
  step.open = await openModelPicker(boot, { waitForFooter: false });
  step.headerSeenAtMs = step.open.headerAt;

  for (let i = 0; i < 4; i += 1) {
    const before = captureFrame(boot);
    boot.host.writeRaw(ARROW_DOWN);
    // Deliberately TIGHT — production's nav window is 2500ms but its presses go
    // out as soon as a frame validates, which is this fast.
    await sleep(220);
    const after = captureFrame(boot);
    step.presses.push({
      press: i + 1,
      beforeCursorGrid: before.l1Grid.cursor,
      afterCursorGrid: after.l1Grid.cursor,
      beforeCursorStream: before.l1Stream.cursor,
      afterCursorStream: after.l1Stream.cursor,
      beforeOrder: before.l1Grid.order,
      afterOrder: after.l1Grid.order,
      moved: before.l1Grid.cursor !== after.l1Grid.cursor,
      orderStable: JSON.stringify(before.l1Grid.order) === JSON.stringify(after.l1Grid.order),
    });
  }

  // Walk back up so the session is left where it started (read-only discipline).
  for (let i = 0; i < step.presses.filter((p) => p.moved).length; i += 1) {
    boot.host.writeRaw(ARROW_UP);
    await sleep(180);
  }
  step.finalFrame = captureFrame(boot);
  step.rollback = await escapeToComposer(boot, 2);
  return step;
}

/**
 * Enter the level the picker opens on the CURRENT row, and catalogue whatever
 * comes next. This is the DEPTH measurement's second half: a two-level picker
 * lands on `Select Reasoning Level for <model>`; a catalog-shaped one lands on
 * another model list. Whatever it is, it is captured verbatim and then Esc'd —
 * this arm confirms a MODEL row but never a reasoning row, so no receipt fires
 * and no session state moves.
 */
async function stepLevel2(boot) {
  const step = { step: "level-2", why: "DEPTH second half + level-2 rows and markers" };
  step.open = await openModelPicker(boot);
  step.l1 = captureFrame(boot);
  step.l1CursorModel = step.l1.l1Grid.cursor;

  boot.host.writeRaw(CR);
  await sleep(1200);
  step.afterEnter = captureFrame(boot);
  step.level2OpenForCursorModel = step.l1CursorModel
    ? codexModelPickerLevel2Open(boot.raw, step.l1CursorModel)
    : null;
  step.level2OpenGeneric = codexModelPickerLevel2Open(boot.raw);
  step.level2OpenGrid = codexModelPickerLevel2Open(boot.screen());

  // Give a late app-server repaint the same chance the hold arm gave level 1.
  await sleep(3000);
  step.afterSettle = captureFrame(boot);

  step.rollback = await escapeToComposer(boot, 3);
  return step;
}

// ── plumbing ────────────────────────────────────────────────────────────────

/** Type bare `/model` and defer the Enter 150ms — the production shape
 *  (`startCodexModelSwitch`: typed text, never bracketed paste, Enter deferred
 *  under the write lock). Returns the ms at which the level-1 header appeared,
 *  or null. */
async function openModelPicker(boot, { waitForFooter = true } = {}) {
  // Clear FIRST, unconditionally — the production RED LINE 1 discipline, and the
  // only thing that keeps a swallowed Enter from turning the next arm's typing
  // into a chat line.
  boot.host.writeRaw(KILL_LINE);
  await sleep(200);
  const composerBefore = boot.screen();
  boot.host.writeRaw("/model");
  await sleep(150);
  boot.host.writeRaw(CR);
  const headerAt = await boot.waitUntil((b) => codexModelPickerLevel1Open(b.raw), 8000, 60);
  if (waitForFooter) {
    await boot.waitUntil((b) => codexModelPickerFooterVisible(b.raw), 4000, 60);
  }
  return { headerAt, composerTailBefore: composerBefore.split("\n").filter((l) => l.trim()).slice(-3) };
}

/** Esc up to `max` times, verifying after each whether a picker footer is still
 *  on screen, and report whether the composer came back. The read-only exit. */
async function escapeToComposer(boot, max) {
  const escs = [];
  for (let i = 0; i < max; i += 1) {
    const footerBefore = codexModelPickerFooterVisible(boot.screen());
    if (!footerBefore && i > 0) break;
    boot.host.writeRaw(ESC);
    await sleep(500);
    escs.push({
      esc: i + 1,
      footerBefore,
      footerAfterGrid: codexModelPickerFooterVisible(boot.screen()),
      footerAfterStream: codexModelPickerFooterVisible(boot.raw),
      l1OpenGrid: codexModelPickerLevel1Open(boot.screen()),
    });
    if (!codexModelPickerFooterVisible(boot.screen())) break;
  }
  await sleep(400);
  return {
    escs,
    composerBack: boot.ready(),
    screenTail: boot.screen().split("\n").filter((l) => l.trim()).slice(-4),
  };
}

/** One instant, measured on BOTH substrates with the PRODUCTION parsers. */
function captureFrame(boot) {
  const screen = boot.screen();
  return {
    atMs: boot.at(),
    // Verbatim rendered rows — the row text, markers and footer keys are read
    // off this, not off a compaction.
    gridLines: screen.split("\n").filter((line) => line.trim()),
    gridCompact: compact(screen),
    l1OpenGrid: codexModelPickerLevel1Open(screen),
    l1OpenStream: codexModelPickerLevel1Open(boot.raw),
    footerGrid: codexModelPickerFooterVisible(screen),
    footerStream: codexModelPickerFooterVisible(boot.raw),
    l1Grid: plainLevel(parseCodexModelLevel1(screen)),
    l1Stream: plainLevel(parseCodexModelLevel1(boot.raw)),
    l2Grid: plainLevel(parseCodexModelLevel2(screen)),
    l2Stream: plainLevel(parseCodexModelLevel2(boot.raw)),
  };
}

/** CodexPickerLevel carries Maps; JSON.stringify would render them as `{}`. */
function plainLevel(level) {
  return {
    cursor: level.cursor,
    current: level.current,
    order: Object.fromEntries(level.order),
    byDigit: Object.fromEntries(level.byDigit),
  };
}

function rowSetSignature(frame) {
  return frame ? JSON.stringify(frame.l1Grid.order) : null;
}

function summarize(out) {
  const lines = [];
  lines.push(`q27 model picker — codex ${out.version}${out.endVersion === out.version ? "" : ` → ${out.endVersion}`}`);
  if (out.fatal) lines.push(`FATAL: ${out.fatal}`);
  lines.push(
    `readyAt=${out.readyAtMs}ms  appServerHandshakeAt=${out.appServerHandshakeAtMs}ms  ` +
      `ready leads handshake by ${out.readyBeforeHandshakeByMs}ms`,
  );
  if (out.idle) {
    lines.push(`\nIDLE (ready at ${out.idle.atMs}ms) glyphs=${JSON.stringify(out.idle.composerGlyphsSeen)}`);
    for (const line of out.idle.tailLines) lines.push(`  | ${line}`);
  }
  for (const step of out.steps) {
    lines.push(`\n── ${step.step} — ${step.why}`);
    if (step.frames) {
      lines.push(`  distinct frames while held: ${step.distinctFrames}  rowSetChanged=${step.rowSetChanged} cursorChanged=${step.cursorChanged}`);
      const first = step.frames.at(0);
      if (first) {
        lines.push(`  first frame l1(grid) cursor=${first.l1Grid.cursor} current=${first.l1Grid.current} order=${JSON.stringify(first.l1Grid.order)}`);
        lines.push(`  first frame l1(stream) cursor=${first.l1Stream.cursor} order=${JSON.stringify(first.l1Stream.order)}`);
        for (const line of first.gridLines) lines.push(`    | ${line}`);
      }
      const last = step.frames.at(-1);
      if (last && last !== first) {
        lines.push(`  LAST frame l1(grid) cursor=${last.l1Grid.cursor} current=${last.l1Grid.current} order=${JSON.stringify(last.l1Grid.order)}`);
        for (const line of last.gridLines) lines.push(`    | ${line}`);
      }
    }
    if (step.presses) {
      lines.push(`  headerSeenAtMs=${step.headerSeenAtMs}`);
      for (const p of step.presses) {
        lines.push(`  press ${p.press}: grid ${p.beforeCursorGrid} → ${p.afterCursorGrid} (moved=${p.moved} orderStable=${p.orderStable}) | stream ${p.beforeCursorStream} → ${p.afterCursorStream}`);
      }
    }
    if (step.afterEnter) {
      lines.push(`  l1 cursor confirmed: ${step.l1CursorModel}`);
      lines.push(`  level2Open(model)=${step.level2OpenForCursorModel} generic=${step.level2OpenGeneric} grid=${step.level2OpenGrid}`);
      lines.push(`  l2(grid) cursor=${step.afterEnter.l2Grid.cursor} current=${step.afterEnter.l2Grid.current} order=${JSON.stringify(step.afterEnter.l2Grid.order)}`);
      lines.push(`  l2(stream) cursor=${step.afterEnter.l2Stream.cursor} current=${step.afterEnter.l2Stream.current} order=${JSON.stringify(step.afterEnter.l2Stream.order)}`);
      for (const line of step.afterEnter.gridLines) lines.push(`    | ${line}`);
      if (step.afterSettle) {
        lines.push(`  after 3s settle: l2(grid) cursor=${step.afterSettle.l2Grid.cursor} order=${JSON.stringify(step.afterSettle.l2Grid.order)}`);
      }
    }
    if (step.rollback) {
      lines.push(`  rollback: escs=${step.rollback.escs.length} composerBack=${step.rollback.composerBack}`);
      for (const e of step.rollback.escs) {
        lines.push(`    esc#${e.esc} footerBefore=${e.footerBefore} afterGrid=${e.footerAfterGrid} afterStream=${e.footerAfterStream} l1OpenGrid=${e.l1OpenGrid}`);
      }
      for (const line of step.rollback.screenTail) lines.push(`    | ${line}`);
    }
  }
  return lines.join("\n");
}
