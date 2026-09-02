// Q17 (2026-09 sync, SL-5) — the Shift+Tab PERMISSION CYCLE at 2.1.258:
// its order, its length, its per-mode phrase + glyph, its input pacing, and the
// occlusion hazard the changelog flagged.
//
// QUESTION (SL-5 objectives 1 + 2). Sonata cannot jump to a permission mode —
// there is no arg form mid-session — so it presses `\x1b[Z` one step at a time
// and reads the TUI mode line as the step's receipt. Two tables encode the
// cycle today, both stamped at claude **2.1.214**:
//   - `CLAUDE_MODE_LINE_PHRASES` (tui-parsers-claude.ts) — 4 phrases → 4 modes;
//     SHARED with SL-2a readiness, so a wrong entry here breaks two things.
//   - `CLAUDE_PERMISSION_CYCLE` — `default → acceptEdits → plan → auto`, which
//     `expectedPermissionLandings` turns into the per-step landing VALIDATOR.
//     A cycle that gained/lost/reordered a member does not make the engine
//     overshoot (it seeks by receipt, it does not count steps) — it makes every
//     real landing read as an "unexpected screen", which is FAIL LOUD: the
//     engine abandons the seek, walks home, and raises needs-attention on a
//     switch the CLI performed correctly.
// So the cycle order is load-bearing as a PREDICATE, not as arithmetic. This
// probe measures the predicate's ground truth.
//
// Four arms:
//   A — CYCLE WALK. 12 Shift+Tab presses from a `--permission-mode default`
//       spawn (3× the modelled cycle), recording after every press: the grid's
//       mode-line row verbatim, its glyph codepoints, and the PRODUCTION
//       parser's verdict on the raw tail. Answers order, length, phrases,
//       whether `plan` and `auto` are on this account — and whether
//       `bypassPermissions` is reachable by blind stepping (a RED LINE: Sonata
//       must never be able to step into it unattended).
//   B — PACING. Upstream fixed fast-key handling twice in the 2.1.22x–2.1.25x
//       range. Does N presses advance exactly N modes at 300 / 120 / 40 / 0 ms
//       spacing? An undershoot (swallowed press) strands the seek; an overshoot
//       (one press = two steps) makes a landing skip a mode, which
//       `expectedPermissionLandings` rejects as an unexpected screen.
//   C — SPAWN DETERMINISM. The 8/14 server-side rollout moved some accounts'
//       startup default to `auto`. Sonata ALWAYS passes `--permission-mode`, so
//       the question is only whether the flag still WINS. Six spawns: no flag
//       (= the account's own default, the control), then each mode Sonata can
//       launch into. `bypassPermissions` is deliberately NOT spawned.
//   D — OCCLUSION. 2.1.248 notes the "Press Ctrl-C again to exit" hint can hide
//       the mode indicator. Sonata reads that line as BOTH the S2 step receipt
//       (`parseClaudePermissionModeLine`, on the raw TAIL) and the SL-2a
//       readiness needle (`CLAUDE_MODE_LINE_ON_SCREEN_RE`, on the GRID). Those
//       two channels fail differently under occlusion, so both are sampled: a
//       hidden-on-grid mode line demotes readiness confidence; a hidden-in-
//       stream one would strand a step. Measured at idle AND immediately after
//       a Shift+Tab (the shape that actually matters: Ctrl-C during a drive).
//
// Read-only w.r.t. the user's claude config: every arm spawns with a scratch
// `--settings` file under /private/tmp and the probe asserts
// ~/.claude/settings.json is byte-identical at the end.
//
// Scratch dirs are /private/tmp/... (never the agent scratchpad, whose path
// embeds the username): these frames become findings and the pre-push leak
// fence scans blob content.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const OUT_DIR = new URL(".", import.meta.url).pathname;
const APP_DIR = new URL("../../../app/", import.meta.url).pathname;
const require = createRequire(APP_DIR + "package.json");
const {
  ensureClaudeRuntimeSettings,
  parseClaudePermissionModeLine,
  CLAUDE_MODE_LINE_ON_SCREEN_RE,
  CLAUDE_PERMISSION_CYCLE,
  expectedPermissionLandings,
} = require(APP_DIR + "dist/runtime");

const { Probe, Capture, KEYS, sleep } = await import("../../upstream-sync-2026-08/claude/driver.mjs");

const EXPECT_VERSION = "2.1.258";
const ROOT = "/private/tmp/sonata-sync-2026-09/permission-cycle";
const COLS = 120;
const ROWS = 40;
/** The engine's own scan window (`controlSwitchScan`, control-switch-engine.ts)
 *  is reset per step and capped at this many chars — parse the same slice the
 *  production engine would, not the whole session transcript. */
const SCAN_LIMIT = 4096;

const HOME = os.homedir();
const USER_MUNGED = `-${HOME.replace(/\//g, "-").replace(/^-/, "")}-`;
const sanitize = (value) =>
  String(value).split(HOME).join("$HOME").split(USER_MUNGED).join("-$USER_MUNGED-");

function readVersion() {
  return execFileSync("claude", ["--version"], { encoding: "utf8" }).trim();
}
function pinVersionOrExit(where) {
  const version = readVersion();
  if (!version.startsWith(EXPECT_VERSION)) {
    console.log(
      JSON.stringify({ success: false, reason: `binary moved off ${EXPECT_VERSION} (${where})`, version }),
    );
    process.exit(2);
  }
  return version;
}
const version = pinVersionOrExit("probe start");

const USER_SETTINGS = path.join(HOME, ".claude", "settings.json");
const settingsBefore = fs.readFileSync(USER_SETTINGS, "utf8");

/** The mode-line row as the GRID renders it, verbatim, plus its glyph
 *  codepoints — the phrase table is only trustworthy if both halves match. */
function modeLineRow(screen) {
  for (const line of screen.split("\n")) {
    const t = line.trim();
    if (/[⏸⏵]/.test(t)) {
      const glyphs = [...t]
        .filter((ch) => /[⏸⏵]/.test(ch))
        .map((ch) => `U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")}`);
      return { text: t, glyphs };
    }
  }
  return null;
}

/** Both channels Sonata reads the mode line on, sampled together. `parser` is
 *  the S2 step receipt (raw tail, compacted); `readinessNeedle` is the SL-2a
 *  footer predicate (grid, whitespace-tolerant). They can disagree — that
 *  disagreement is exactly what arm D is looking for. */
function sampleChannels(p, scan) {
  const screen = p.screen();
  const row = modeLineRow(screen);
  return {
    parser: parseClaudePermissionModeLine(scan),
    readinessNeedle: CLAUDE_MODE_LINE_ON_SCREEN_RE.test(screen),
    gridRow: row ? row.text : null,
    gridGlyphs: row ? row.glyphs : null,
  };
}

/** A probe with a per-step scan window that mirrors the engine's: reset on
 *  demand (`resetScan`), capped at SCAN_LIMIT, fed from the pty stream. */
function armScan(p) {
  const state = { scan: "" };
  p.pty.onData((chunk) => {
    state.scan = (state.scan + chunk).slice(-SCAN_LIMIT);
  });
  return state;
}

async function bootProbe(label, extraArgs, { permissionMode = "default" } = {}) {
  const cwd = path.join(ROOT, label);
  const runtimeDir = path.join(ROOT, `${label}-runtime`);
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(runtimeDir, { recursive: true });
  const settingsPath = ensureClaudeRuntimeSettings(runtimeDir, {});
  const args = [
    ...(permissionMode === null ? [] : ["--permission-mode", permissionMode]),
    "--settings",
    settingsPath,
    ...extraArgs,
  ];
  const p = new Probe({ cwd, rows: ROWS, cols: COLS, args });
  const trust = await p.waitFor(/Quick safety check|trust this folder/i, 45_000);
  if (trust) {
    // The COMMITTED production walk (SL-1): the 2.1.252+ default row is
    // "No, exit", so a bare Enter declines and kills the session.
    for (let i = 0; i < 6; i++) {
      await sleep(500);
      p.write(KEYS.down);
      await sleep(350);
      if (p.screen().split("\n").some((l) => /❯\s*Yes, I trust this folder/i.test(l))) break;
    }
    p.write(KEYS.enter);
    await sleep(1500);
  }
  // The mode line IS the readiness needle (SL-2a) — waiting on it is waiting on
  // the composer, and it is also the value arm C wants to read.
  const ready = await p.waitFor(CLAUDE_MODE_LINE_ON_SCREEN_RE, 60_000);
  await sleep(2500);
  return { p, ready, args };
}

/** Press Shift+Tab once and wait until the mode line CHANGES (or the window
 *  expires), returning what landed and how long it took. `from` is the mode we
 *  pressed from — the same anchor `writePermissionStep` records — so a repaint
 *  of `from` is not mistaken for the landing. */
async function stepOnce(p, scanState, from, { windowMs = 1500, pollMs = 25 } = {}) {
  scanState.scan = "";
  const t0 = Date.now();
  p.write(KEYS.shiftTab);
  let landed = null;
  let landedAtMs = null;
  const deadline = t0 + windowMs;
  while (Date.now() < deadline) {
    const parsed = parseClaudePermissionModeLine(scanState.scan);
    if (parsed && parsed !== from) {
      landed = parsed;
      landedAtMs = Date.now() - t0;
      break;
    }
    await sleep(pollMs);
  }
  // Let the frame settle so the grid sample is the post-press screen.
  await sleep(200);
  return { landed, landedAtMs, channels: sampleChannels(p, scanState.scan) };
}

async function armA(cap, results) {
  const { p, ready, args } = await bootProbe("a-cycle", []);
  const scan = armScan(p);
  try {
    const boot = sampleChannels(p, p.raw.slice(-SCAN_LIMIT));
    cap.frame(p, "A — boot (--permission-mode default)");
    cap.add("A — boot channels", JSON.stringify({ ready, args: args.map(sanitize), boot }, null, 2));
    const walk = [];
    let from = boot.parser;
    // 12 presses = 3× the modelled 4-mode cycle: enough to see the cycle repeat
    // twice and to catch a 5th or 6th member that only shows up late.
    for (let i = 0; i < 12; i++) {
      const step = await stepOnce(p, scan, from, { windowMs: 1500 });
      walk.push({
        press: i + 1,
        from,
        landed: step.landed,
        landedAtMs: step.landedAtMs,
        gridRow: step.channels.gridRow,
        gridGlyphs: step.channels.gridGlyphs,
        readinessNeedle: step.channels.readinessNeedle,
        // The production validator's verdict for THIS transition, computed
        // against the modelled cycle — a `false` is the fail-loud path.
        acceptedByExpectedLandings:
          from && step.landed ? expectedPermissionLandings(from).has(step.landed) : null,
      });
      cap.frame(p, `A — after press ${i + 1} (${from} → ${step.landed})`);
      if (step.landed) from = step.landed;
      await sleep(500);
    }
    results.a = {
      ready,
      boot,
      walk,
      observedOrder: dedupeCycle(walk),
      sawBypass: walk.some((s) => s.landed === "bypassPermissions"),
      unparsedSteps: walk.filter((s) => !s.landed).length,
      rejectedByValidator: walk.filter((s) => s.acceptedByExpectedLandings === false).length,
    };
    cap.add("A — cycle verdict", JSON.stringify(results.a, null, 2));
  } finally {
    p.kill();
    await sleep(600);
  }
}

/** The distinct mode sequence the walk traced, collapsed to one full cycle:
 *  walk forward from the first landing until a mode repeats. */
function dedupeCycle(walk) {
  const seq = [];
  for (const step of walk) {
    if (!step.landed) break;
    if (seq.includes(step.landed)) break;
    seq.push(step.landed);
  }
  return seq;
}

async function armB(cap, results) {
  results.b = [];
  // 3 presses per burst: from `default`, three steps should land on the cycle's
  // 4th member (or wrap). The DELTA between spacings is the measurement — a
  // burst that lands short swallowed a press, one that lands long doubled one.
  for (const gapMs of [300, 120, 40, 0]) {
    const label = `b-gap${gapMs}`;
    const { p, ready } = await bootProbe(label, []);
    const scan = armScan(p);
    try {
      const before = sampleChannels(p, p.raw.slice(-SCAN_LIMIT));
      scan.scan = "";
      for (let i = 0; i < 3; i++) {
        p.write(KEYS.shiftTab);
        if (gapMs > 0) await sleep(gapMs);
      }
      // Generous settle: the question is where 3 presses LAND, not how fast.
      await sleep(2500);
      const after = sampleChannels(p, scan.scan);
      const entry = {
        gapMs,
        ready,
        presses: 3,
        before: before.parser,
        after: after.parser,
        afterGridRow: after.gridRow,
      };
      results.b.push(entry);
      cap.frame(p, `B — 3 presses at ${gapMs}ms spacing`);
      cap.add(`B — gap ${gapMs}ms verdict`, JSON.stringify(entry, null, 2));
    } finally {
      p.kill();
      await sleep(600);
    }
  }
}

async function armC(cap, results) {
  results.c = [];
  // `null` = NO --permission-mode flag at all: the account's own startup
  // default, the control the 8/14 rollout question needs. bypassPermissions is
  // deliberately absent — Sonata never launches into it and the probe will not
  // be the first thing that does.
  for (const mode of [null, "default", "acceptEdits", "plan", "auto", "dontAsk"]) {
    const label = `c-${mode ?? "noflag"}`;
    const { p, ready, args } = await bootProbe(label, [], { permissionMode: mode });
    try {
      const boot = sampleChannels(p, p.raw.slice(-SCAN_LIMIT));
      const entry = {
        requested: mode,
        ready,
        exited: p.exited,
        exitInfo: p.exitInfo ?? null,
        bootMode: boot.parser,
        bootGridRow: boot.gridRow,
        flagWon: mode === null ? null : boot.parser === mode,
        args: args.map(sanitize),
        complaintLines: p
          .screen()
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => /invalid|unsupported|not supported|unknown|error|not allowed/i.test(l)),
      };
      results.c.push(entry);
      cap.frame(p, `C — spawn ${mode ?? "(no --permission-mode flag)"}`);
      cap.add(`C — ${label} verdict`, JSON.stringify(entry, null, 2));
    } finally {
      p.kill();
      await sleep(600);
    }
  }
}

async function armD(cap, results) {
  const { p, ready } = await bootProbe("d-occlusion", []);
  const scan = armScan(p);
  try {
    const samples = [];
    const take = (label) => {
      const s = sampleChannels(p, scan.scan);
      samples.push({ label, ...s });
      cap.frame(p, `D — ${label}`);
      return s;
    };
    scan.scan = p.raw.slice(-SCAN_LIMIT);
    take("idle, before Ctrl-C");

    // One Ctrl-C at an IDLE composer: the 2.1.248 hint shape.
    p.write(KEYS.ctrlC);
    await sleep(400);
    take("idle + 400ms after one Ctrl-C");
    await sleep(1600);
    take("idle + 2.0s after one Ctrl-C");
    await sleep(4000);
    take("idle + 6.0s after one Ctrl-C (hint expired?)");

    // The shape that actually matters for the drive: a Ctrl-C landing in the
    // same beat as a Shift+Tab step, so the step's receipt window overlaps the
    // hint. Scan is reset like `writePermissionStep` does.
    const from = parseClaudePermissionModeLine(scan.scan);
    scan.scan = "";
    p.write(KEYS.shiftTab);
    await sleep(60);
    p.write(KEYS.ctrlC);
    await sleep(600);
    const raced = take("Shift+Tab then Ctrl-C 60ms later (step receipt window)");
    await sleep(5000);
    take("6s after the raced pair");

    results.d = {
      ready,
      from,
      racedStepParsed: raced.parser,
      racedStepReadinessNeedle: raced.readinessNeedle,
      samples,
      // The two failure shapes, named:
      //   receiptLost  — the STEP would have timed out (no mode line in the
      //                  per-step scan window) → engine fails loud.
      //   readinessLost — the GRID lost the footer needle → SL-2a confidence
      //                  demotes while the session is perfectly fine.
      receiptLostUnderOcclusion: raced.parser === null,
      readinessLostUnderOcclusion: samples.some((s) => s.label.includes("Ctrl-C") && !s.readinessNeedle),
    };
    cap.add("D — occlusion verdict", JSON.stringify(results.d, null, 2));
  } finally {
    p.kill();
    await sleep(600);
  }
}

async function main() {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(ROOT, { recursive: true });
  const cap = new Capture(
    path.join(OUT_DIR, "q17-permission-cycle.capture.txt"),
    `Q17 — claude Shift+Tab permission cycle, spawn determinism, occlusion (claude ${version})`,
  );
  const results = { version, modelledCycle: [...CLAUDE_PERMISSION_CYCLE] };

  await armA(cap, results);
  await armB(cap, results);
  await armC(cap, results);
  await armD(cap, results);

  results.userSettingsUnchanged = fs.readFileSync(USER_SETTINGS, "utf8") === settingsBefore;
  const endVersion = readVersion();
  results.versionAtEnd = endVersion;
  results.versionDrift = !endVersion.startsWith(EXPECT_VERSION);
  cap.add("fence", JSON.stringify({ userSettingsUnchanged: results.userSettingsUnchanged, endVersion }, null, 2));
  // SL-4 method note: an END drift must not discard a completed capture — save
  // first, report the drift, exit non-zero afterwards.
  cap.save();
  console.log(sanitize(JSON.stringify(results, null, 2)));
  if (results.versionDrift) process.exitCode = 2;
}

main().catch((error) => {
  console.error(sanitize(String(error?.stack ?? error)));
  process.exit(1);
});
