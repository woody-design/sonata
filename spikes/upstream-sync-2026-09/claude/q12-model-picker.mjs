// Q12 (2026-09 sync, SL-4) — the claude `/model` PICKER re-walk at 2.1.258.
//
// QUESTION (SL-4 objective 1). The last MEASURED walk of this surface was
// 2.1.220 (5 rows, "Opus (1M context)" among them). Since then the Claude 5
// family shipped, upstream moved the picker's highlight to "newest model only",
// started rendering model names as CODE, and the picker became height-clipped +
// scrollable. Sonata's `MODEL_OPTIONS.claude` is the menu the USER picks from
// and its LABELS are the key `sessionModelValue()` maps the live statusline
// `model.display_name` back onto — so a label the picker no longer prints is a
// silently wrong "current model" mark, and a row the picker offers that Sonata
// lacks is a missing capability. Measure the live list.
//
// READ-ONLY BY CONSTRUCTION. This probe NEVER selects a row: every picker visit
// ends in Esc. `/model <x>` (and a picker Enter) rewrites the user's GLOBAL
// default model — the known wart SL-4 explicitly leaves in place — so the
// mutating half lives in q13, which brackets itself with a settings.json
// backup/restore. Nothing here touches user state.
//
// WHY ONE PROCESS AND A RESIZE LADDER, not four spawns: the clipping question is
// "what does the picker do at Sonata's pty height", and the honest comparison is
// the SAME picker at four heights. A resize is the same SIGWINCH the real app
// sends when the user drags the window, so it is also the more production-shaped
// stimulus. Heights: 40 (this probe family's baseline), 36 (Sonata's
// DEFAULT_ROWS — `terminal-dimensions.ts`), then 24 and 16 for a pane a user has
// actually squeezed.
//
// Scratch dirs are /private/tmp/... (never the agent scratchpad, whose path
// embeds the username): these frames become findings and the pre-push leak fence
// scans blob content.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const OUT_DIR = new URL(".", import.meta.url).pathname;
const APP_DIR = new URL("../../../app/", import.meta.url).pathname;
const require = createRequire(APP_DIR + "package.json");
const { ensureClaudeRuntimeSettings } = require(APP_DIR + "dist/runtime");

const { Probe, Capture, KEYS, sleep } = await import("../../upstream-sync-2026-08/claude/driver.mjs");

const EXPECT_VERSION = "2.1.258";
const ROOT = "/private/tmp/sonata-sync-2026-09/model-picker";
const COLS = 120;

const HOME = os.homedir();
const USER_MUNGED = `-${HOME.replace(/\//g, "-").replace(/^-/, "")}-`;
const sanitize = (value) =>
  String(value).split(HOME).join("$HOME").split(USER_MUNGED).join("-$USER_MUNGED-");

// The version pin. A START drift aborts before anything is measured (there is
// nothing to lose). An END drift must NOT exit before the capture is written —
// the 2026-09-01 auto-update from 2.1.257 to 2.1.258 landed mid-run and the
// original hard exit discarded a completed measurement along with the drift it
// was reporting. So the end pin RECORDS the drift, lets the caller save, and the
// process exits non-zero afterwards: the run is still unusable, but its evidence
// survives to say so.
function readVersion() {
  return execFileSync("claude", ["--version"], { encoding: "utf8" }).trim();
}
function pinVersionOrExit() {
  const version = readVersion();
  if (!version.startsWith(EXPECT_VERSION)) {
    console.log(JSON.stringify({ success: false, reason: `binary moved off ${EXPECT_VERSION} (probe start)`, version }));
    process.exit(2);
  }
  return version;
}
const version = pinVersionOrExit();

// ─── settings-mutation fence ────────────────────────────────────────────────
// This probe must not change the user's global default model / effort. Snapshot
// the bytes up front and assert them byte-identical at the end; a drift here is
// a probe BUG (something selected a row), reported loudly rather than restored
// quietly, because a silent restore would hide the fact that Esc stopped being
// a clean exit.
const USER_SETTINGS = path.join(HOME, ".claude", "settings.json");
const settingsBefore = fs.readFileSync(USER_SETTINGS, "utf8");

// ─── helpers ────────────────────────────────────────────────────────────────

const CURSOR = "❯";

/** The rows the picker is currently SHOWING, in screen order, with the focused
 *  one flagged. A picker row is any grid line carrying a bullet/cursor glyph or
 *  sitting inside the list block; rather than guess the block, we take every
 *  non-empty line between the picker title and its footer. */
function pickerRows(screen) {
  const lines = screen.split("\n");
  const titleIdx = lines.findIndex((l) => /select\s+model|choose\s+a?\s*model|^\s*Model\b/i.test(l));
  const footerIdx = lines.findIndex((l, i) => i > titleIdx && /to (confirm|select|switch)|Esc to/i.test(l));
  const from = titleIdx >= 0 ? titleIdx + 1 : 0;
  const to = footerIdx > from ? footerIdx : lines.length;
  return lines
    .slice(from, to)
    .map((raw, i) => ({ y: from + i, text: raw.replace(/\s+$/, "") }))
    .filter((r) => r.text.trim().length > 0);
}

/** Is the picker on screen at all? Its title is the cheapest unambiguous mark. */
function pickerOpen(screen) {
  return /^\s*Select model\s*$/m.test(screen);
}

/** The label on the row carrying `❯`, whitespace-collapsed, cursor stripped.
 *
 *  Scanned BOTTOM-UP, which is load-bearing: closing the picker leaves an echoed
 *  `❯ /model` line in the TRANSCRIPT above, and a top-down scan reads that stale
 *  command echo as the focused row (measured — the first q12 run mistook it for
 *  every arm after the first). The picker paints below the transcript, so the
 *  last labelled cursor row is the live one. The composer's own bare `❯ ` prompt
 *  carries no label and is skipped. */
function focusedRow(screen) {
  const lines = screen.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i].trim();
    if (!t.startsWith(CURSOR)) continue;
    const label = t.slice(CURSOR.length).trim().replace(/\s+/g, " ");
    if (label) return label;
  }
  return null;
}

async function openPicker(p, cap, label) {
  const before = p.raw.length;
  await p.type("/model", 25);
  await sleep(600);
  p.write(KEYS.enter);
  await sleep(1400);
  cap.frame(p, `${label} — picker OPEN`, { attrs: true });
  cap.addRaw(`${label} — picker-open RAW delta (SGR around row names)`, p.raw.slice(before));
  return pickerOpen(p.screen());
}

async function closePicker(p, cap, label) {
  const before = p.raw.length;
  p.write(KEYS.esc);
  await sleep(900);
  cap.frame(p, `${label} — after Esc (picker closed?)`);
  cap.addRaw(`${label} — Esc-cancel RAW delta (cancel receipt)`, p.raw.slice(before));
  return !pickerOpen(p.screen());
}

// ─── the walk ───────────────────────────────────────────────────────────────

/**
 * Walk the picker with Down presses, recording the focused label after each and
 * WHICH rows the window shows. Stops when focus returns to the first label (a
 * wrap proves the whole list was seen) or after `maxSteps`.
 *
 * `stepMs` is the read delay AFTER the arrow. The brief's warning about the
 * upstream fast-arrow-then-Enter regressions is why the walk is measured at two
 * pacings (see the `fast` arm): a swallowed arrow shows up here as a repeated
 * label, not as a wrong selection, because this probe never presses Enter.
 */
async function walk(p, cap, label, { stepMs = 400, maxSteps = 16 } = {}) {
  const first = focusedRow(p.screen());
  const seq = [{ step: 0, focused: first, visible: pickerRows(p.screen()).map((r) => r.text.trim()) }];
  let wrapped = false;
  for (let i = 1; i <= maxSteps; i++) {
    p.write(KEYS.down);
    await sleep(stepMs);
    const screen = p.screen();
    const focused = focusedRow(screen);
    seq.push({ step: i, focused, visible: pickerRows(screen).map((r) => r.text.trim()) });
    if (i > 1 && focused && focused === first) {
      wrapped = true;
      break;
    }
  }
  cap.add(
    `${label} — Down walk (stepMs=${stepMs})`,
    seq
      .map(
        (s) =>
          `step ${String(s.step).padStart(2)}  focused=${JSON.stringify(s.focused)}\n` +
          s.visible.map((v) => `        | ${v}`).join("\n"),
      )
      .join("\n"),
  );
  return { seq, wrapped };
}

// ─── main ───────────────────────────────────────────────────────────────────

async function main() {
  fs.rmSync(ROOT, { recursive: true, force: true });
  const cwd = path.join(ROOT, "walk");
  const runtimeDir = path.join(ROOT, "runtime");
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(runtimeDir, { recursive: true });
  const settingsPath = ensureClaudeRuntimeSettings(runtimeDir, {});

  const cap = new Capture(path.join(OUT_DIR, "q12-model-picker.capture.txt"), `Q12 — /model picker walk (claude ${version})`);
  cap.add("spawn shape", `claude --permission-mode default --settings <production runtime settings>\ncols=${COLS}`);

  // Boot at the tallest height; the ladder shrinks from there.
  const p = new Probe({ cwd, rows: 40, cols: COLS, args: ["--permission-mode", "default", "--settings", settingsPath] });
  const results = { version, heights: [], notes: [] };
  try {
    const trust = await p.waitFor(/Quick safety check|trust this folder/i, 45_000);
    if (trust) {
      cap.frame(p, "boot — trust dialog");
      for (let i = 0; i < 6; i++) {
        await sleep(500);
        p.write(KEYS.down);
        await sleep(350);
        if (p.screen().split("\n").some((l) => /❯\s*Yes, I trust this folder/i.test(l))) break;
      }
      p.write(KEYS.enter);
      await sleep(1500);
    }
    // 2.1.257's production boot prints NONE of the 2026-08 composer needles
    // (`for shortcuts` / `Welcome back` / `Try "`), and `>\s*$` never matches
    // because the footer paints BELOW the composer. The mode line is the
    // measured idle marker (F6) and is what production readiness keys on too.
    const ready = await p.waitFor(/(⏸|⏵⏵)\s*(manual|plan|accept edits|auto)/i, 60_000);
    cap.add("boot — composer reached?", `${ready} (trustDialogSeen=${trust})`);
    await sleep(2500);
    cap.frame(p, "boot — idle composer (production spawn)");
    if (!ready) throw new Error("never reached a composer");

    for (const rows of [40, 36, 24, 16]) {
      const label = `H${rows}`;
      if (rows !== 40) {
        p.pty.resize(COLS, rows);
        p.term.resize(COLS, rows);
        await sleep(1800);
        cap.frame(p, `${label} — after resize to ${COLS}x${rows} (composer)`);
      }
      const opened = await openPicker(p, cap, label);
      const initialFocus = focusedRow(p.screen());
      const initialVisible = pickerRows(p.screen()).map((r) => r.text.trim());
      const { seq, wrapped } = await walk(p, cap, label, { stepMs: 400 });
      const order = [];
      for (const s of seq) {
        if (s.focused && order[order.length - 1] !== s.focused) order.push(s.focused);
      }
      // A wrap means the last entry repeats the first — drop the duplicate.
      if (wrapped && order.length > 1 && order[0] === order[order.length - 1]) order.pop();
      const closed = await closePicker(p, cap, label);
      results.heights.push({
        rows,
        opened,
        initialFocus,
        initialVisibleCount: initialVisible.length,
        initialVisible,
        walkOrder: order,
        wrapped,
        // Did the WINDOW move (rows entering/leaving), as opposed to only the
        // cursor moving inside a fixed window?
        scrolled: seq.some((s) => s.visible.join("|") !== seq[0].visible.join("|")),
        distinctRowsReachedByWalk: order.length,
        closedCleanly: closed,
      });
    }

    // Fast-arrow arm at Sonata's default height: does the picker SWALLOW arrows
    // sent at the production pacing (OPTION_PROMPT_KEY_DELAY_MS = 300ms) or
    // faster? Measured as "how many distinct rows did N arrows traverse".
    p.pty.resize(COLS, 36);
    p.term.resize(COLS, 36);
    await sleep(1500);
    for (const stepMs of [300, 60, 0]) {
      const label = `FAST${stepMs}`;
      await openPicker(p, cap, label);
      const start = focusedRow(p.screen());
      const N = 3;
      for (let i = 0; i < N; i++) {
        p.write(KEYS.down);
        if (stepMs) await sleep(stepMs);
      }
      await sleep(1200);
      const landed = focusedRow(p.screen());
      cap.frame(p, `${label} — after ${N} Downs at ${stepMs}ms spacing`);
      results.notes.push({ arm: label, stepMs, presses: N, start, landed, stillOpen: pickerOpen(p.screen()) });
      await closePicker(p, cap, label);
    }
  } finally {
    cap.frame(p, "final — screen at teardown");
    p.kill();
    await sleep(500);
    const settingsAfter = fs.readFileSync(USER_SETTINGS, "utf8");
    results.userSettingsUnchanged = settingsAfter === settingsBefore;
    if (!results.userSettingsUnchanged) {
      results.userSettingsDrift = { before: settingsBefore, after: settingsAfter };
    }
    cap.add("user settings.json byte-identical after probe?", String(results.userSettingsUnchanged));
    const endVersion = readVersion();
    results.versionAtEnd = endVersion;
    results.versionDrift = !endVersion.startsWith(EXPECT_VERSION);
    cap.add("binary version at probe end", `${endVersion}${results.versionDrift ? "  *** DRIFTED — this run is NOT a valid measurement ***" : ""}`);
    cap.save();
    console.log(sanitize(JSON.stringify(results, null, 2)));
    if (results.versionDrift) {
      process.exitCode = 2;
    }
  }
}

main().catch((error) => {
  console.error(sanitize(String(error?.stack ?? error)));
  process.exit(1);
});
