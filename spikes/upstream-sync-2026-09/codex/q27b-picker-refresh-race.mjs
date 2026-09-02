// Q27b (2026-09 sync, SL-7) — the `/model` picker opened INTO the app-server
// handshake, at 50ms granularity.
//
// WHY A SECOND PROBE. q27 answered the refresh question (#41467) on a WARM
// session: the picker was opened ~22s after boot, held untouched for 20s, and
// its row set and highlight never moved. That is a real measurement but it is
// the EASY case — by then the app server had answered long ago (q27 measured the
// handshake landing at 348ms), so the refresh had nothing new to say and a
// "nothing changed" reads as "no refresh exists" when it may only mean "the
// refresh agreed with the paint".
//
// The case that can actually hurt the choreography is the opposite one: the
// picker painted from whatever codex knows LOCALLY, then re-painted from the app
// server with a different answer, while `captureCodexModelLevel` has already
// snapshotted `order`/`byDigit` from the first frame and is navigating on it.
// The only window in which the two answers can differ is the one before the
// handshake completes — so this probe opens the picker AS EARLY AS SONATA WOULD
// ALLOW IT (the instant `acceptsPromptInput()` goes true) and watches at 50ms.
//
// TWO THINGS ARE MEASURED, and they are independent:
//   1. Does a `/model` + Enter delivered in the pre-handshake window OPEN the
//      picker at all? q27's RUN 1 accidentally measured that it does NOT — the
//      Enter was swallowed and `/model` was left sitting in the composer. That
//      is a boot-latch (C14 / SL-6) stress, so it is measured deliberately here
//      rather than left as an anecdote.
//   2. If it opens (or once it does), does the ROW SET or the HIGHLIGHT change
//      between the first painted frame and the settled one?
//
// READ-ONLY: the picker is only ever opened and Esc'd. No row is confirmed.
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
  sleep,
  writeCapture,
} from "./driver.mjs";

const {
  codexModelPickerFooterVisible,
  codexModelPickerLevel1Open,
  parseCodexModelLevel1,
} = runtime;

const OUT_DIR = new URL(".", import.meta.url).pathname;
const ROOT = "/private/tmp/sonata-sync-2026-09/codex-picker-refresh";
const COLS = 120;
const ROWS = 40;
const BOOT_BUDGET_MS = 90_000;
const WATCH_MS = 25_000;
const POLL_MS = 50;
const ESC = "\x1b";
const CR = "\r";
const KILL_LINE = "\x15".repeat(40);
const MODEL_LINE_LOADING_RE = /model:\s+loading/;

const startVersion = assertCodexVersion("q27b start");

fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(ROOT, { recursive: true });

const realCodexHome = process.env.CODEX_HOME?.trim() || path.join(os.homedir(), ".codex");
const realProfilePath = path.join(realCodexHome, "sonata.config.toml");
const profileBackup = fs.existsSync(realProfilePath)
  ? fs.readFileSync(realProfilePath, "utf8")
  : null;

const out = {
  probe: "q27b-picker-refresh-race",
  version: startVersion,
  endVersion: null,
  versionDrift: null,
  arms: [],
};

try {
  // ARM A — fire the moment Sonata says the composer accepts input, i.e. INTO
  // the handshake window.
  out.arms.push(await runArm("at-ready", { waitForHandshake: false }));
  // ARM B — the control: same session shape, but the open waits for the
  // handshake. Any frame delta seen in A and absent in B is attributable to the
  // race rather than to the picker in general.
  out.arms.push(await runArm("after-handshake", { waitForHandshake: true }));
} catch (error) {
  out.fatal = `${error instanceof Error ? error.stack : String(error)}`;
} finally {
  if (profileBackup !== null) fs.writeFileSync(realProfilePath, profileBackup);
}

out.endVersion = codexVersion();
out.versionDrift = out.endVersion.includes(EXPECT_CODEX_VERSION)
  ? null
  : `drifted off ${EXPECT_CODEX_VERSION}: start=${out.version} end=${out.endVersion}`;

const capturePath = writeCapture(OUT_DIR, "q27b-picker-refresh-race.capture.txt", out);
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

async function runArm(armName, { waitForHandshake }) {
  const runRoot = path.join(ROOT, armName);
  const workspace = path.join(runRoot, "cwd");
  const runtimeDir = path.join(runRoot, "runtime");
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(runtimeDir, { recursive: true });

  const boot = new CodexBoot({
    taskId: `task-q27b-${armName}`,
    cwd: workspace,
    runtimeDir,
    binDir: path.join(os.homedir(), ".sonata", "bin"),
    pretrustCwd: workspace,
    rows: ROWS,
    cols: COLS,
    approvalBroker: true,
  });

  const arm = { arm: armName, waitForHandshake, frames: [] };
  try {
    await boot.start();
    arm.readyAtMs = await boot.waitUntil((b) => b.ready(), BOOT_BUDGET_MS);
    if (arm.readyAtMs === null) {
      arm.fatal = "never ready";
      return arm;
    }
    arm.handshakeDoneAtReady = !MODEL_LINE_LOADING_RE.test(boot.screen());
    if (waitForHandshake) {
      arm.handshakeAtMs = await boot.waitUntil(
        (b) => !MODEL_LINE_LOADING_RE.test(b.screen()),
        30_000,
        50,
      );
      await sleep(500);
    }

    arm.openSentAtMs = boot.at();
    boot.host.writeRaw(KILL_LINE);
    await sleep(120);
    boot.host.writeRaw("/model");
    await sleep(150);
    boot.host.writeRaw(CR);

    // Poll from BEFORE the header exists, so a first paint that is later
    // replaced cannot slip between two samples.
    const deadline = Date.now() + WATCH_MS;
    let lastKey = null;
    while (Date.now() < deadline) {
      const screen = boot.screen();
      const level = parseCodexModelLevel1(screen);
      const frame = {
        atMs: boot.at(),
        headerGrid: codexModelPickerLevel1Open(screen),
        headerStream: codexModelPickerLevel1Open(boot.raw),
        footerGrid: codexModelPickerFooterVisible(screen),
        cursor: level.cursor,
        current: level.current,
        order: Object.fromEntries(level.order),
        handshakeLoading: MODEL_LINE_LOADING_RE.test(screen),
        gridLines: screen.split("\n").filter((l) => l.trim()),
      };
      const key = JSON.stringify([frame.headerGrid, frame.cursor, frame.current, frame.order, frame.footerGrid]);
      if (key !== lastKey) {
        lastKey = key;
        arm.frames.push(frame);
      }
      await sleep(POLL_MS);
    }

    arm.pickerEverOpened = arm.frames.some((f) => f.headerGrid);
    const opened = arm.frames.filter((f) => f.headerGrid && Object.keys(f.order).length);
    arm.firstOpenFrame = opened.at(0) ?? null;
    arm.lastOpenFrame = opened.at(-1) ?? null;
    arm.rowSetChanged =
      arm.firstOpenFrame && arm.lastOpenFrame
        ? JSON.stringify(arm.firstOpenFrame.order) !== JSON.stringify(arm.lastOpenFrame.order)
        : null;
    arm.cursorChanged =
      arm.firstOpenFrame && arm.lastOpenFrame
        ? arm.firstOpenFrame.cursor !== arm.lastOpenFrame.cursor
        : null;
    arm.distinctOpenFrames = opened.length;

    boot.host.writeRaw(ESC);
    await sleep(600);
    arm.composerBack = boot.ready() && !codexModelPickerFooterVisible(boot.screen());
    arm.finalTail = boot.screen().split("\n").filter((l) => l.trim()).slice(-4);
  } catch (error) {
    arm.fatal = `${error instanceof Error ? error.stack : String(error)}`;
  } finally {
    boot.dispose();
    await sleep(300);
  }
  return arm;
}

function summarize(out) {
  const lines = [`q27b picker refresh race — codex ${out.version}`];
  if (out.fatal) lines.push(`FATAL: ${out.fatal}`);
  for (const arm of out.arms) {
    lines.push(`\n── arm ${arm.arm} (waitForHandshake=${arm.waitForHandshake})`);
    if (arm.fatal) lines.push(`  FATAL: ${arm.fatal}`);
    lines.push(
      `  readyAt=${arm.readyAtMs}ms handshakeDoneAtReady=${arm.handshakeDoneAtReady} ` +
        `handshakeAt=${arm.handshakeAtMs ?? "n/a"} openSentAt=${arm.openSentAtMs}ms`,
    );
    lines.push(
      `  pickerEverOpened=${arm.pickerEverOpened} distinctOpenFrames=${arm.distinctOpenFrames} ` +
        `rowSetChanged=${arm.rowSetChanged} cursorChanged=${arm.cursorChanged}`,
    );
    if (arm.firstOpenFrame) {
      lines.push(`  FIRST open frame @${arm.firstOpenFrame.atMs}ms handshakeLoading=${arm.firstOpenFrame.handshakeLoading}`);
      lines.push(`    cursor=${arm.firstOpenFrame.cursor} current=${arm.firstOpenFrame.current}`);
      lines.push(`    order=${JSON.stringify(arm.firstOpenFrame.order)}`);
    }
    if (arm.lastOpenFrame && arm.lastOpenFrame !== arm.firstOpenFrame) {
      lines.push(`  LAST  open frame @${arm.lastOpenFrame.atMs}ms`);
      lines.push(`    cursor=${arm.lastOpenFrame.cursor} current=${arm.lastOpenFrame.current}`);
      lines.push(`    order=${JSON.stringify(arm.lastOpenFrame.order)}`);
    }
    if (!arm.pickerEverOpened) {
      const last = arm.frames.at(-1);
      lines.push("  picker NEVER opened — final grid:");
      for (const l of last?.gridLines ?? []) lines.push(`    | ${l}`);
    }
    lines.push(`  composerBack=${arm.composerBack}`);
    for (const l of arm.finalTail ?? []) lines.push(`    | ${l}`);
  }
  return lines.join("\n");
}
