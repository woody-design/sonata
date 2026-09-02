// Q14 (2026-09 sync, SL-4) — does the PRODUCTION receipt window mis-fire on a
// repainting transcript?
//
// WHY THIS PROBE EXISTS. Q13 read each switch's verdict ONCE, off the whole raw
// delta, and two late arms came back `failed` for switches that had plainly
// succeeded (`B4 /model haiku`, `B5 /model sonnet` — the mirror moved, the
// receipt said "Set model to …", the parser said failed). The needle that fired
// was `Model 'bogus-model-xyz' not found` — a receipt from an EARLIER arm,
// re-entering the byte stream because 2.1.252+ renders in the alternate screen
// and REPAINTS transcript lines as they shift up.
//
// But q13's read is NOT production's. `detectControlSwitchReceipt` keeps a
// rolling 4096-char window, appends ONE pty chunk at a time, and acts on the
// FIRST chunk that yields a verdict — so a fresh receipt arriving before a stale
// repaint would settle first and the hazard would be theoretical. Which of those
// two it is decides whether SL-4 ships a parser change, so it gets measured
// rather than argued: this probe replays `detectControlSwitchReceipt`'s exact
// ladder (same constant, same slice, same first-verdict-wins, same
// failure-before-success ordering) chunk by chunk over a LIVE session, and
// compares each verdict with the ground truth from the statusline mirror.
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
const { ensureClaudeRuntimeSettings, parseClaudeControlReceipt } = require(APP_DIR + "dist/runtime");

const { Probe, Capture, KEYS, sleep } = await import("../../upstream-sync-2026-08/claude/driver.mjs");

const EXPECT_VERSION = "2.1.258";
const ROOT = "/private/tmp/sonata-sync-2026-09/receipt-window";
const COLS = 120;
const ROWS = 40;
// `CONTROL_SWITCH_SCAN_LIMIT` from tui-parsers-claude.ts. Restated (not imported)
// so a probe that silently followed a future change to the constant cannot
// pretend it re-measured the shape it actually measured.
const SCAN_LIMIT = 4096;

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

const USER_SETTINGS = path.join(HOME, ".claude", "settings.json");
const settingsBefore = fs.readFileSync(USER_SETTINGS, "utf8");

let usageDir = "";
function mirror() {
  let newest = null;
  let newestAt = 0;
  for (const entry of fs.readdirSync(usageDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.startsWith("claude-") || !entry.name.endsWith(".json")) continue;
    const full = path.join(usageDir, entry.name);
    const at = fs.statSync(full).mtimeMs;
    if (at > newestAt) {
      newestAt = at;
      newest = full;
    }
  }
  if (!newest) return null;
  try {
    const payload = JSON.parse(fs.readFileSync(newest, "utf8"));
    return {
      displayName: payload?.model?.display_name ?? null,
      effort: payload?.effort?.level ?? payload?.effort ?? null,
    };
  } catch {
    return { unreadable: true };
  }
}

async function main() {
  fs.rmSync(ROOT, { recursive: true, force: true });
  const cwd = path.join(ROOT, "session");
  const runtimeDir = path.join(ROOT, "runtime");
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(runtimeDir, { recursive: true });
  const settingsPath = ensureClaudeRuntimeSettings(runtimeDir, {});
  usageDir = path.join(runtimeDir, "usage");

  const cap = new Capture(
    path.join(OUT_DIR, "q14-receipt-window.capture.txt"),
    `Q14 — production receipt-window replay (claude ${version})`,
  );

  const p = new Probe({
    cwd,
    rows: ROWS,
    cols: COLS,
    args: ["--permission-mode", "default", "--settings", settingsPath],
  });

  // The production ladder, armed per switch. `chunks` is the live tap.
  let armed = null;
  p.pty.onData((chunk) => {
    if (!armed) return;
    armed.chunkCount += 1;
    armed.scan = (armed.scan + chunk).slice(-SCAN_LIMIT);
    if (armed.verdict) return;
    const verdict = parseClaudeControlReceipt(armed.scan, armed.kind);
    if (verdict) {
      armed.verdict = verdict;
      armed.verdictChunk = armed.chunkCount;
      armed.verdictAtMs = Date.now() - armed.t0;
      // Snapshot the window that produced the verdict — the evidence, verbatim.
      armed.verdictWindow = armed.scan;
    }
  });

  const results = { version, arms: [] };
  try {
    const trust = await p.waitFor(/Quick safety check|trust this folder/i, 45_000);
    if (trust) {
      for (let i = 0; i < 6; i++) {
        await sleep(500);
        p.write(KEYS.down);
        await sleep(350);
        if (p.screen().split("\n").some((l) => /❯\s*Yes, I trust this folder/i.test(l))) break;
      }
      p.write(KEYS.enter);
      await sleep(1500);
    }
    if (!(await p.waitFor(/(⏸|⏵⏵)\s*(manual|plan|accept edits|auto)/i, 60_000))) {
      throw new Error("never reached a composer");
    }
    await sleep(3000);

    /**
     * One switch, driven and WATCHED the way production does it.
     *
     * `mode: "production"` reproduces `writeClaudeValueCommand` exactly and the
     * ordering is the whole point: the command goes out as ONE pty write, the
     * watch is armed IMMEDIATELY AFTER that write (so the repaint the write
     * provokes is inside the window — it arrives asynchronously), and the
     * submitting `\r` follows 120ms later under the same deferral.
     *
     * `mode: "early"` arms BEFORE typing, per-character. It is not production;
     * it is kept as the contrast arm, because the first q14 run used it and the
     * difference between the two is the measurement: how much of the repaint
     * traffic a switch's window swallows is decided entirely by where the arming
     * point sits.
     */
    async function arm(label, kind, value, mode) {
      const command = `/${kind} ${value}`;
      const fresh = () => ({
        kind, scan: "", chunkCount: 0, verdict: null, verdictChunk: null,
        verdictAtMs: null, verdictWindow: "", t0: Date.now(),
      });
      if (mode === "production") {
        p.write(command);
        armed = fresh();
        await sleep(120);
        p.write("\r");
      } else {
        armed = fresh();
        await p.type(command, 25);
        await sleep(600);
        p.write("\r");
      }
      await sleep(6000);
      const snapshot = armed;
      armed = null;
      const truth = mirror();
      const cleanWindow = snapshot.verdictWindow.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
      const compact = cleanWindow.replace(/\s+/g, "");
      const entry = {
        label,
        mode,
        kind,
        value,
        productionVerdict: snapshot.verdict,
        verdictChunk: snapshot.verdictChunk,
        chunksSeen: snapshot.chunkCount,
        verdictAtMs: snapshot.verdictAtMs,
        mirrorAfter: truth,
        // Did the winning window carry a needle that CANNOT belong to this
        // switch? A `not found` line when we asked for a real model, or a
        // `Set model to <X>` naming a model that is not this switch's target.
        windowCarriedStaleNotFound: /Model\s*'[^']*'\s*not\s*found/.test(cleanWindow),
        windowSetModelToCount: (compact.match(/Setmodelto/g) ?? []).length,
        windowSetEffortToCount: (compact.match(/Seteffortlevelto/g) ?? []).length,
      };
      cap.add(`${label} [${mode}] — ladder verdict`, JSON.stringify(entry, null, 2));
      cap.addRaw(`${label} [${mode}] — the window that produced the verdict`, snapshot.verdictWindow);
      results.arms.push(entry);
      return entry;
    }

    // Ladder P — PRODUCTION arming. This is the one that decides whether SL-4
    // ships a parser change.
    //   P1 a clean switch on a clean transcript (control)
    //   P2 the poison: a genuine failure, leaving `Model '…' not found` in the
    //      transcript for the rest of the session
    //   P3+ successful switches after the poison. Ground truth is the mirror.
    await arm("P1 /model sonnet (clean)", "model", "sonnet", "production");
    await arm("P2 /model bogus-model-xyz (poison)", "model", "bogus-model-xyz", "production");
    await arm("P3 /model haiku", "model", "haiku", "production");
    await arm("P4 /model sonnet", "model", "sonnet", "production");
    await arm("P5 /effort high", "effort", "high", "production");
    await arm("P6 /model haiku", "model", "haiku", "production");
    await arm("P7 /model sonnet", "model", "sonnet", "production");
    await arm("P8 /model haiku", "model", "haiku", "production");
    await arm("P9 /model sonnet", "model", "sonnet", "production");

    // Ladder E — EARLY arming, on the now-long transcript the P ladder built.
    // The contrast arm: same session, same needles, a window that also contains
    // the typing burst.
    await arm("E1 /model haiku", "model", "haiku", "early");
    await arm("E2 /model sonnet", "model", "sonnet", "early");
    await arm("E3 /model haiku", "model", "haiku", "early");
    cap.frame(p, "final — transcript after both ladders");
  } finally {
    p.kill();
    await sleep(800);
    fs.writeFileSync(USER_SETTINGS, settingsBefore, "utf8");
    results.userSettingsRestored = fs.readFileSync(USER_SETTINGS, "utf8") === settingsBefore;
    const endVersion = readVersion();
    results.versionAtEnd = endVersion;
    results.versionDrift = !endVersion.startsWith(EXPECT_VERSION);
    cap.add("binary version at probe end", `${endVersion}${results.versionDrift ? "  *** DRIFTED — this run is NOT a valid measurement ***" : ""}`);
    cap.add("user settings restored?", String(results.userSettingsRestored));
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
