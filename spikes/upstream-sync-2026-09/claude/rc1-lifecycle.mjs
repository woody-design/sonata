// RC1 (2026-09 sync, SL-11) — RECON: the Remote Control surface at claude 2.1.258
// under Sonata's PRODUCTION spawn shape.
//
// QUESTION. F4 saw RC auto-connect at boot on this account, with a banner
// carrying the session URL and a footer `/rc` pill — a surface Sonata's
// detector (`REMOTE_CONTROL_URL_RE` on the raw stream) was not written against.
// Before re-deriving anything, measure the ground truth:
//
//   A — NO FLAG (the production default: Woody's `defaultRemoteControl:false`
//       means Sonata does NOT pass `--remote-control`). Does RC connect anyway?
//       What does the banner say verbatim, what does the footer pill say, and
//       — decisive — does the session URL ever reach the RAW pty stream, which
//       is the only channel `detectRemoteControlState` reads?
//   B — WITH `--remote-control` (the armed path). Same measurements.
//
// Both arms sample the two channels Sonata could read, side by side, at every
// beat: the RAW tail through the link/disconnect readers that were production
// AT THE TIME OF THIS PROBE (`findRemoteControlUrl` — since retired, and kept
// inline below precisely so this measurement stays reproducible —
// `hasRemoteControlDisconnect` ∘ `compactRemoteControlScan`) and the GRID (what
// TaskScreenModel reconstructs). F5b already showed these two disagree since
// the alternate-screen move; this probe asks whether RC is another instance.
//
// Read-only w.r.t. the user's claude config: scratch `--settings` under
// /private/tmp, and ~/.claude/settings.json is byte-compared at the end.
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
  hasRemoteControlDisconnect,
  compactRemoteControlScan,
  REMOTE_CONTROL_SCAN_LIMIT,
} = require(APP_DIR + "dist/runtime");

const { Probe, Capture, KEYS, sleep } = await import("../../upstream-sync-2026-08/claude/driver.mjs");

/** The RETIRED stream reader, kept LOCAL and verbatim. SL-11 moved the link read
 *  to the grid (findRemoteControlUrlOnScreen) precisely because this function
 *  goes blind on a differential repaint — and this probe exists to measure that,
 *  so it must keep calling the broken thing, not the fixed one. Inlined rather
 *  than imported so the probe still runs after the export was removed. */
function findRemoteControlUrl(raw) {
  return (
    raw
      .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
      .match(/https:\/\/claude\.(?:ai|com)\/code\/session_[A-Za-z0-9_-]+/)?.[0] ?? null
  );
}

const EXPECT_VERSION = "2.1.258";
const ROOT = "/private/tmp/sonata-sync-2026-09/rc-lifecycle";
const COLS = 120;
const ROWS = 40;

const HOME = os.homedir();
const USER_MUNGED = `-${HOME.replace(/\//g, "-").replace(/^-/, "")}-`;
const sanitize = (value) =>
  String(value).split(HOME).join("$HOME").split(USER_MUNGED).join("-$USER_MUNGED-");
/** Session ids are account-scoped identifiers; the shapes are what matter. */
const redactSession = (value) =>
  String(value).replace(/session_[A-Za-z0-9_-]+/g, "session_<REDACTED>");
const scrub = (value) => redactSession(sanitize(value));

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

/** Rows of the rendered grid that mention RC in any of its shapes. Deliberately
 *  broad (`/rc`, "Remote Control", a claude.ai session link) — the point is to
 *  discover the surface, not to confirm a guess. */
function rcGridRows(screen) {
  return screen
    .split("\n")
    .map((line, y) => ({ y, text: line.trim() }))
    .filter(
      (row) =>
        /remote control/i.test(row.text) ||
        /\/rc\b/.test(row.text) ||
        /claude\.(ai|com)\/code\/session_/.test(row.text) ||
        /connecting|disconnect/i.test(row.text),
    );
}

/** Both channels, sampled at one instant. `scan` is the rolling RAW tail the
 *  production detector would hold (same cap); `rawAll` is the whole stream —
 *  the difference between them IS the "did the needle scroll out of the
 *  window" question. */
function sampleChannels(p, scan) {
  const screen = p.screen();
  return {
    // What production sees today.
    rawTail: {
      url: findRemoteControlUrl(scan),
      off: hasRemoteControlDisconnect(compactRemoteControlScan(scan)),
    },
    // What production WOULD see with an unbounded window — separates "the
    // needle never appeared" from "the needle appeared and aged out".
    rawAll: {
      url: findRemoteControlUrl(p.raw),
      off: hasRemoteControlDisconnect(compactRemoteControlScan(p.raw)),
    },
    grid: {
      rows: rcGridRows(screen),
      urlOnGrid: screen.match(/https:\/\/claude\.(?:ai|com)\/code\/session_[A-Za-z0-9_-]+/)?.[0] ?? null,
      offOnGrid: /Remote Control disconnected/.test(screen),
    },
  };
}

/** A rolling RAW tail that mirrors `detectRemoteControlState`'s window exactly. */
function armScan(p) {
  const state = { scan: "" };
  p.pty.onData((chunk) => {
    state.scan = (state.scan + chunk).slice(-REMOTE_CONTROL_SCAN_LIMIT);
  });
  return state;
}

async function bootProbe(label, extraArgs) {
  const cwd = path.join(ROOT, label);
  const runtimeDir = path.join(ROOT, `${label}-runtime`);
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(runtimeDir, { recursive: true });
  const settingsPath = ensureClaudeRuntimeSettings(runtimeDir, {});
  // Sonata's real arg shape (terminal-host buildClaudeArgs): permission mode,
  // the merged settings file, then `--remote-control` LAST when armed.
  const args = ["--permission-mode", "default", "--settings", settingsPath, ...extraArgs];
  const p = new Probe({ cwd, rows: ROWS, cols: COLS, args });
  const scan = armScan(p);
  const trust = await p.waitFor(/Quick safety check|trust this folder/i, 45_000);
  if (trust) {
    // SL-1's committed walk: the 2.1.252+ default row is "No, exit".
    for (let i = 0; i < 6; i++) {
      await sleep(500);
      p.write(KEYS.down);
      await sleep(350);
      if (p.screen().split("\n").some((l) => /❯\s*Yes, I trust this folder/i.test(l))) break;
    }
    p.write(KEYS.enter);
    await sleep(1500);
  }
  const ready = await p.waitFor(/for shortcuts|Welcome back|Try "|⏵|⏸/i, 60_000);
  return { p, scan, ready, args, trust };
}

/** Watch for `windowMs`, sampling both channels every `everyMs`, and keep the
 *  whole series — RC connection is asynchronous, so "did it ever" needs a
 *  timeline, not a single reading. */
async function watch(p, scan, cap, label, { windowMs, everyMs = 3000 }) {
  const series = [];
  const t0 = Date.now();
  let frames = 0;
  let lastKey = "";
  while (Date.now() - t0 < windowMs) {
    const s = sampleChannels(p, scan.scan);
    const atMs = Date.now() - t0;
    series.push({ atMs, ...s });
    // Frame the screen whenever the RC rows CHANGE — a transition is worth a
    // verbatim frame; a steady state is not worth 30 of them.
    const key = JSON.stringify(s.grid.rows.map((r) => r.text));
    if (key !== lastKey) {
      cap.frame(p, `${label} — grid at +${atMs}ms (RC rows changed)`);
      lastKey = key;
      frames++;
    }
    await sleep(everyMs);
  }
  cap.add(`${label} — channel series`, scrub(JSON.stringify(series, null, 2)));
  return { series, frames };
}

/** Condense a series into the questions the slice actually asks. */
function verdict(series) {
  const first = (pred) => series.find(pred) ?? null;
  const firstGridUrl = first((s) => s.grid.urlOnGrid);
  const firstRawUrl = first((s) => s.rawTail.url);
  const firstRawAllUrl = first((s) => s.rawAll.url);
  return {
    everConnectedOnGrid: Boolean(firstGridUrl),
    gridUrlFirstSeenAtMs: firstGridUrl?.atMs ?? null,
    // The production channel. `false` here with `true` above is the whole finding.
    productionRawTailSawUrl: Boolean(firstRawUrl),
    rawTailUrlFirstSeenAtMs: firstRawUrl?.atMs ?? null,
    unboundedRawSawUrl: Boolean(firstRawAllUrl),
    unboundedRawUrlFirstSeenAtMs: firstRawAllUrl?.atMs ?? null,
    // Every distinct RC row the grid ever rendered, verbatim — the needle pool.
    distinctGridRows: [...new Set(series.flatMap((s) => s.grid.rows.map((r) => r.text)))],
  };
}

async function armA(cap, results) {
  // NO --remote-control: exactly what Sonata spawns today under Woody's default.
  const { p, scan, ready, args, trust } = await bootProbe("a-noflag", []);
  try {
    cap.frame(p, "A — boot, NO --remote-control (production default)");
    cap.add("A — spawn", scrub(JSON.stringify({ ready, trust, args }, null, 2)));
    // 75s: F4's connect was visible within the first boot beats, but the pill
    // goes `connecting…` → connected, and a slow network could stretch that.
    const { series } = await watch(p, scan, cap, "A", { windowMs: 75_000 });
    results.a = { ready, args: args.map(sanitize), ...verdict(series) };
    cap.add("A — verdict", scrub(JSON.stringify(results.a, null, 2)));
    // The raw stream, verbatim, around the banner — needed to write needles
    // against the STREAM if the URL is there at all.
    const bannerIdx = p.raw.search(/claude\.(?:ai|com)\/code\/session_/);
    results.aRawBannerFound = bannerIdx >= 0;
    cap.add(
      "A — RAW stream around the first session-link occurrence",
      bannerIdx >= 0
        ? scrub(JSON.stringify(p.raw.slice(Math.max(0, bannerIdx - 1200), bannerIdx + 600)))
        : "(no `claude.ai/code/session_` anywhere in the raw stream)",
    );
    cap.add("A — RAW stream size", String(p.raw.length));
  } finally {
    p.kill();
    await sleep(800);
  }
}

async function armB(cap, results) {
  const { p, scan, ready, args, trust } = await bootProbe("b-flag", ["--remote-control"]);
  try {
    cap.frame(p, "B — boot WITH --remote-control (Sonata's armed path)");
    cap.add("B — spawn", scrub(JSON.stringify({ ready, trust, args }, null, 2)));
    const { series } = await watch(p, scan, cap, "B", { windowMs: 75_000 });
    results.b = { ready, args: args.map(sanitize), ...verdict(series) };
    cap.add("B — verdict", scrub(JSON.stringify(results.b, null, 2)));
    const bannerIdx = p.raw.search(/claude\.(?:ai|com)\/code\/session_/);
    results.bRawBannerFound = bannerIdx >= 0;
    cap.add(
      "B — RAW stream around the first session-link occurrence",
      bannerIdx >= 0
        ? scrub(JSON.stringify(p.raw.slice(Math.max(0, bannerIdx - 1200), bannerIdx + 600)))
        : "(no `claude.ai/code/session_` anywhere in the raw stream)",
    );
    cap.add("B — RAW stream size", String(p.raw.length));
  } finally {
    p.kill();
    await sleep(800);
  }
}

async function main() {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(ROOT, { recursive: true });
  const cap = new Capture(
    path.join(OUT_DIR, "rc1-lifecycle.capture.txt"),
    `RC1 — Remote Control surface recon, production spawn shape (claude ${version})`,
  );
  const results = { version, scanLimit: REMOTE_CONTROL_SCAN_LIMIT };

  await armA(cap, results);
  await armB(cap, results);

  results.userSettingsUnchanged = fs.readFileSync(USER_SETTINGS, "utf8") === settingsBefore;
  const endVersion = readVersion();
  results.versionAtEnd = endVersion;
  results.versionDrift = !endVersion.startsWith(EXPECT_VERSION);
  cap.add("fence", JSON.stringify({ userSettingsUnchanged: results.userSettingsUnchanged, endVersion }, null, 2));
  cap.save();
  console.log(scrub(JSON.stringify(results, null, 2)));
  if (results.versionDrift) process.exitCode = 2;
}

main().catch((error) => {
  console.error(scrub(String(error?.stack ?? error)));
  process.exit(1);
});
