// RC2 (2026-09 sync, SL-11) — does Remote Control AUTO-START at boot, and can
// Sonata's spawn influence it? Strict A/B, one variable: the `--settings` file.
//
// WHY. F4 (2026-09-01, claude 2.1.252) measured RC connecting at boot with NO
// `--remote-control` flag: banner + `/rc connecting…` → green `/rc`. That fact
// collides with Woody's product default (`defaultRemoteControl: false` → Sonata
// does NOT pass the flag), because it would mean every Sonata session is
// phone-reachable regardless of the setting. RC1 at 2.1.258 did NOT reproduce
// it under Sonata's production spawn. Before writing either fact into the
// findings, isolate the variable.
//
// Three legs, each a FRESH cwd, each with NO `--remote-control`:
//   noSettings     — bare `--permission-mode default`  (q1-B's exact shape,
//                    the leg that auto-connected at 2.1.252)
//   statusLineOnly — q1-A's exact shape (a statusLine command, nothing else)
//   sonata         — Sonata's real merged settings (statusLine + hooks +
//                    emojiCompletionEnabled), i.e. production
// plus one positive control:
//   flagged        — Sonata's settings + `--remote-control`, so a leg that
//                    reads "no connect" everywhere is distinguishable from a
//                    probe that simply cannot see a connect.
//
// Every leg samples the same three channels each beat: the RAW tail through the
// PRODUCTION detector, the GRID text, and the footer pill's STYLED cells (the
// pill's text is `/rc` whether RC is on or off — only its COLOR moves, which is
// exactly what a text-only grid consumer cannot read).
//
// Read-only w.r.t. the user's claude config (scratch `--settings`, byte-compare
// at the end). Scratch dirs are /private/tmp/... (never the agent scratchpad,
// whose path embeds the username): these frames become findings and the
// pre-push leak fence scans blob content.
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
const ROOT = "/private/tmp/sonata-sync-2026-09/rc-autostart";
const COLS = 120;
const ROWS = 40;
const WATCH_MS = 60_000;

const HOME = os.homedir();
const USER_MUNGED = `-${HOME.replace(/\//g, "-").replace(/^-/, "")}-`;
const sanitize = (v) => String(v).split(HOME).join("$HOME").split(USER_MUNGED).join("-$USER_MUNGED-");
const redactSession = (v) => String(v).replace(/session_[A-Za-z0-9_-]+/g, "session_<REDACTED>");
const scrub = (v) => redactSession(sanitize(v));

function readVersion() {
  return execFileSync("claude", ["--version"], { encoding: "utf8" }).trim();
}
function pinVersionOrExit(where) {
  const version = readVersion();
  if (!version.startsWith(EXPECT_VERSION)) {
    console.log(JSON.stringify({ success: false, reason: `binary moved off ${EXPECT_VERSION} (${where})`, version }));
    process.exit(2);
  }
  return version;
}
const version = pinVersionOrExit("probe start");

const USER_SETTINGS = path.join(HOME, ".claude", "settings.json");
const settingsBefore = fs.readFileSync(USER_SETTINGS, "utf8");
const USER_CONFIG = path.join(HOME, ".claude.json");
/** The RC-relevant user-scope keys, before and after: if a probe leg MUTATES
 *  the user's RC config (an auto-start opt-in written on first connect, say),
 *  that is itself a finding and must not go unnoticed. */
function rcUserKeys() {
  const raw = JSON.parse(fs.readFileSync(USER_CONFIG, "utf8"));
  return Object.fromEntries(
    Object.keys(raw)
      .filter((k) => /remote|^rc[A-Z]/i.test(k))
      .map((k) => [k, raw[k]]),
  );
}
const rcKeysBefore = rcUserKeys();

/** The inputs claude's OWN auto-start resolver reads, sampled from the user's
 *  cached config. Verbatim from the 2.1.258 binary:
 *    remoteControlAtStartup ← policySettings | flagSettings | userSettings
 *                             | legacy global config
 *    …and when that is undefined, the default is
 *      remote env → false; persistent remote session → true;
 *      org policy `remote_control_at_startup` → its value;
 *      else the GrowthBook flag `tengu_cobalt_harbor` (default false).
 *  So a leg's outcome is only interpretable alongside these. The GrowthBook bag
 *  is CACHED and refreshed asynchronously, which means this value can change
 *  BETWEEN probe runs with no local action at all — recording it is what makes
 *  a "did not connect" reading falsifiable instead of anecdotal. */
function autoStartInputs() {
  const raw = JSON.parse(fs.readFileSync(USER_CONFIG, "utf8"));
  const user = JSON.parse(fs.readFileSync(USER_SETTINGS, "utf8"));
  return {
    tengu_cobalt_harbor: raw.cachedGrowthBookFeatures?.tengu_cobalt_harbor ?? null,
    growthBookCachedAt: raw.cachedGrowthBookFeaturesAt
      ? new Date(raw.cachedGrowthBookFeaturesAt).toISOString()
      : null,
    userSettingsRemoteControlAtStartup: user.remoteControlAtStartup ?? null,
    legacyGlobalRemoteControlAtStartup: raw.remoteControlAtStartup ?? null,
  };
}

/** The `/rc` pill as the footer renders it: its text run AND its foreground
 *  colour. `/rc` is present in every state; the colour is the state. */
function footerPill(p) {
  for (const row of p.attrRows()) {
    for (const mark of row.marks) {
      if (mark.chars.includes("/rc")) {
        return { y: row.y, chars: mark.chars, key: mark.key, rowText: row.text.trim() };
      }
    }
  }
  return null;
}

function rcGridRows(screen) {
  return screen
    .split("\n")
    .map((line, y) => ({ y, text: line.trim() }))
    .filter(
      (r) =>
        /remote control/i.test(r.text) ||
        /\/rc\b/.test(r.text) ||
        /claude\.(ai|com)\/code\/session_/.test(r.text) ||
        /Keep working from anywhere/i.test(r.text),
    );
}

function sample(p, scan) {
  const screen = p.screen();
  return {
    rawTail: {
      url: findRemoteControlUrl(scan),
      off: hasRemoteControlDisconnect(compactRemoteControlScan(scan)),
    },
    rawAllUrl: findRemoteControlUrl(p.raw),
    grid: {
      rows: rcGridRows(screen),
      urlOnGrid: screen.match(/https:\/\/claude\.(?:ai|com)\/code\/session_[A-Za-z0-9_-]+/)?.[0] ?? null,
    },
    pill: footerPill(p),
  };
}

function armScan(p) {
  const state = { scan: "" };
  p.pty.onData((c) => {
    state.scan = (state.scan + c).slice(-REMOTE_CONTROL_SCAN_LIMIT);
  });
  return state;
}

const LEGS = [
  { label: "noSettings", settings: "none", flag: false },
  { label: "statusLineOnly", settings: "statusline", flag: false },
  { label: "sonata", settings: "sonata", flag: false },
  { label: "flagged", settings: "sonata", flag: true },
];

function settingsArgs(label, kind) {
  if (kind === "none") return [];
  const runtimeDir = path.join(ROOT, `${label}-runtime`);
  fs.mkdirSync(runtimeDir, { recursive: true });
  if (kind === "statusline") {
    const p = path.join(runtimeDir, "statusline-only-settings.json");
    fs.writeFileSync(
      p,
      JSON.stringify({ statusLine: { type: "command", command: "echo sonata-status-probe" } }),
    );
    return ["--settings", p];
  }
  return ["--settings", ensureClaudeRuntimeSettings(runtimeDir, {})];
}

async function runLeg(cap, leg) {
  const cwd = path.join(ROOT, leg.label);
  fs.mkdirSync(cwd, { recursive: true });
  const args = [
    "--permission-mode",
    "default",
    ...settingsArgs(leg.label, leg.settings),
    ...(leg.flag ? ["--remote-control"] : []),
  ];
  const p = new Probe({ cwd, rows: ROWS, cols: COLS, args });
  const scan = armScan(p);
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
    const ready = await p.waitFor(/for shortcuts|Welcome back|Try "|⏵|⏸/i, 60_000);
    cap.frame(p, `${leg.label} — composer reached (trustDialog=${trust})`, { attrs: true });

    const series = [];
    const t0 = Date.now();
    let lastKey = "";
    while (Date.now() - t0 < WATCH_MS) {
      const s = sample(p, scan.scan);
      series.push({ atMs: Date.now() - t0, ...s });
      const key = JSON.stringify([s.grid.rows.map((r) => r.text), s.pill?.key ?? null]);
      if (key !== lastKey) {
        cap.frame(p, `${leg.label} — RC surface changed at +${Date.now() - t0}ms`, { attrs: true });
        lastKey = key;
      }
      await sleep(2500);
    }

    const firstConnect = series.find((s) => s.grid.urlOnGrid) ?? null;
    const firstRawUrl = series.find((s) => s.rawTail.url) ?? null;
    const verdict = {
      leg: leg.label,
      args: args.map(sanitize),
      ready,
      trustDialog: trust,
      connected: Boolean(firstConnect),
      connectedAtMs: firstConnect?.atMs ?? null,
      productionRawTailSawUrl: Boolean(firstRawUrl),
      rawTailUrlAtMs: firstRawUrl?.atMs ?? null,
      sawConnectingPill: series.some((s) => /connecting/i.test(s.pill?.rowText ?? "")),
      // Every distinct pill rendering the leg produced — text + colour key.
      distinctPills: [...new Set(series.map((s) => JSON.stringify(s.pill)))].map((v) => JSON.parse(v)),
      distinctGridRows: [...new Set(series.flatMap((s) => s.grid.rows.map((r) => r.text)))],
    };
    cap.add(`${leg.label} — verdict`, scrub(JSON.stringify(verdict, null, 2)));
    cap.add(`${leg.label} — channel series`, scrub(JSON.stringify(series, null, 2)));
    return verdict;
  } finally {
    p.kill();
    await sleep(900);
  }
}

async function main() {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(ROOT, { recursive: true });
  const cap = new Capture(
    path.join(OUT_DIR, "rc2-autostart-ab.capture.txt"),
    `RC2 — does RC auto-start at boot? --settings A/B + flagged control (claude ${version})`,
  );
  const results = { version, autoStartInputsBefore: autoStartInputs(), legs: [] };
  cap.add("auto-start resolver inputs (before)", JSON.stringify(results.autoStartInputsBefore, null, 2));
  for (const leg of LEGS) {
    // Sampled PER LEG, not once: the GrowthBook bag refreshes asynchronously, so
    // a mid-run flip must be attributable to the leg it landed in.
    const inputs = autoStartInputs();
    const verdict = await runLeg(cap, leg);
    results.legs.push({ ...verdict, autoStartInputs: inputs });
  }
  results.autoStartInputsAfter = autoStartInputs();
  results.rcUserKeysBefore = rcKeysBefore;
  results.rcUserKeysAfter = rcUserKeys();
  results.rcUserKeysUnchanged =
    JSON.stringify(results.rcUserKeysBefore) === JSON.stringify(results.rcUserKeysAfter);
  results.userSettingsUnchanged = fs.readFileSync(USER_SETTINGS, "utf8") === settingsBefore;
  const endVersion = readVersion();
  results.versionAtEnd = endVersion;
  results.versionDrift = !endVersion.startsWith(EXPECT_VERSION);
  cap.add("fence", scrub(JSON.stringify(results, null, 2)));
  cap.save();
  console.log(scrub(JSON.stringify(results, null, 2)));
  if (results.versionDrift) process.exitCode = 2;
}

main().catch((e) => {
  console.error(scrub(String(e?.stack ?? e)));
  process.exit(1);
});
